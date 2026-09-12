'use client';

// Cuentas bancarias y tarjetas del negocio.
//
// Son GLOBALES, sin store_id: la Amex paga para cualquier sucursal.
//
// El saldo NO se guarda, se deriva (vista fin_v_account_balance):
//   saldo = saldo inicial ± lo que se movió por esta cuenta
// Guardarlo materializado sería una segunda fuente de verdad que se
// desincroniza en cuanto se corrige un pago.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import FinShell from '@/components/finanzas/FinShell';
import AccountFormModal, { Account } from '@/components/finanzas/AccountFormModal';
import {
  FinNotice,
  FinStatCard,
  Notice,
  EmptyState,
  btnPrimary,
  btnSecondary,
} from '@/components/finanzas/ui';
import { fetchAllPages } from '@/lib/finanzas/queries';
import { finErrorMessage } from '@/lib/finanzas/errors';
import { fmtUSD, ACCOUNT_KIND_LABEL } from '@/lib/finanzas/money';
import { formatDate } from '@/lib/finanzas/dates';
import { downloadFinWorkbook, finFilename, FMT_USD } from '@/lib/finanzas/excel';

type ViewRow = {
  account_id: string;
  balance_usd: number;
  available_usd: number | null;
  moved_usd: number;
};

export default function CuentasPage() {
  const supabase = useMemo(() => createClient(), []);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<Map<string, ViewRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tab, setTab] = useState<'negocio' | 'personal'>('negocio');
  const [showInactive, setShowInactive] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    // La tabla trae todo lo editable; la vista trae lo calculado. Se cruzan por
    // id en vez de repetir columnas en la vista.
    const { rows, error } = await fetchAllPages<Account>((from, to) =>
      supabase
        .from('fin_accounts')
        .select(
          'id, name, kind, bank_name, last4, currency, opening_balance_usd, opening_balance_date, credit_limit_usd, statement_day, due_day, is_personal, is_active, notes',
        )
        .order('name')
        .range(from, to),
    );
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      setLoading(false);
      return;
    }

    const { rows: view } = await fetchAllPages<ViewRow>((from, to) =>
      supabase
        .from('fin_v_account_balance')
        .select('account_id, balance_usd, available_usd, moved_usd')
        .range(from, to),
    );

    setAccounts(rows);
    setBalances(new Map(view.map((v) => [v.account_id, v])));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const bal = useCallback((id: string) => balances.get(id), [balances]);

  const visible = useMemo(
    () =>
      accounts.filter(
        (a) => a.is_personal === (tab === 'personal') && (showInactive || a.is_active),
      ),
    [accounts, tab, showInactive],
  );

  const cash = visible.filter((a) => a.kind !== 'tarjeta_credito');
  const cards = visible.filter((a) => a.kind === 'tarjeta_credito');

  const totals = useMemo(() => {
    const activos = visible.filter((a) => a.is_active);
    const disponible = activos
      .filter((a) => a.kind !== 'tarjeta_credito')
      .reduce((acc, a) => acc + Number(bal(a.id)?.balance_usd ?? a.opening_balance_usd ?? 0), 0);
    const deuda = activos
      .filter((a) => a.kind === 'tarjeta_credito')
      .reduce((acc, a) => acc + Number(bal(a.id)?.balance_usd ?? a.opening_balance_usd ?? 0), 0);
    const cupo = activos
      .filter((a) => a.kind === 'tarjeta_credito' && a.credit_limit_usd != null)
      .reduce((acc, a) => acc + Number(bal(a.id)?.available_usd ?? 0), 0);
    return { disponible, deuda, cupo };
  }, [visible, bal]);

  const toggleActive = async (a: Account) => {
    const next = !a.is_active;
    if (
      a.is_active &&
      !window.confirm(
        `¿Desactivar "${a.name}"?\n\nDeja de aparecer al registrar pagos, pero su historial se conserva.`,
      )
    )
      return;

    const { error } = await supabase.from('fin_accounts').update({ is_active: next }).eq('id', a.id);
    if (error) {
      setNotice({ type: 'error', text: finErrorMessage(error) });
      return;
    }
    setAccounts((prev) => prev.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)));
  };

  const handleSaved = (saved: Account, isNew: boolean) => {
    setAccounts((prev) =>
      isNew
        ? [...prev, saved].sort((x, y) => x.name.localeCompare(y.name, 'es'))
        : prev.map((x) => (x.id === saved.id ? saved : x)),
    );
    setTab(saved.is_personal ? 'personal' : 'negocio');
    setNotice({
      type: 'success',
      text: isNew ? `"${saved.name}" creada.` : `"${saved.name}" actualizada.`,
    });
    // El saldo lo calcula la vista: hay que releerla para reflejar un cambio de
    // saldo inicial.
    load();
  };

  // De las tarjetas salen SOLO los ultimos 4 digitos, igual que en pantalla:
  // el archivo se comparte y no puede llevar mas que eso.
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFinWorkbook({
        filename: finFilename(tab === 'personal' ? 'cuentas_personales' : 'cuentas_y_tarjetas'),
        cover: {
          title: tab === 'personal' ? 'Cuentas personales' : 'Cuentas y tarjetas del negocio',
          extra: [
            ['Efectivo y bancos', fmtUSD(totals.disponible)],
            ['Deuda en tarjetas', fmtUSD(totals.deuda)],
            ['Cupo disponible', fmtUSD(totals.cupo)],
            ['Nota', 'De las tarjetas solo se guardan los ultimos 4 digitos'],
          ],
        },
        sheets: [
          {
            name: 'Cuentas y tarjetas',
            columns: [
              { header: 'Cuenta', key: 'cuenta', width: 26 },
              { header: 'Tipo', key: 'tipo', width: 20 },
              { header: 'Banco', key: 'banco', width: 20 },
              { header: 'Ultimos 4', key: 'last4', width: 11, align: 'center' },
              { header: 'Saldo / Consumo', key: 'saldo', width: 16, numFmt: FMT_USD },
              { header: 'Limite', key: 'limite', width: 14, numFmt: FMT_USD },
              { header: 'Disponible', key: 'disponible', width: 14, numFmt: FMT_USD },
              { header: 'Corte', key: 'corte', width: 9, align: 'center' },
              { header: 'Pago', key: 'pago', width: 9, align: 'center' },
              { header: 'Activa', key: 'activa', width: 9, align: 'center' },
            ],
            rows: visible.map((a) => {
              const b = bal(a.id);
              return {
                cuenta: a.name,
                tipo: ACCOUNT_KIND_LABEL[a.kind] ?? a.kind,
                banco: a.bank_name ?? '',
                last4: a.last4 ?? '',
                saldo: Number(b?.balance_usd ?? a.opening_balance_usd ?? 0),
                limite: Number(a.credit_limit_usd ?? 0),
                disponible: Number(b?.available_usd ?? 0),
                corte: a.statement_day ?? '',
                pago: a.due_day ?? '',
                activa: a.is_active ? 'Si' : 'No',
              };
            }),
            note: 'Nunca se guarda el numero completo de la tarjeta, ni el CVV, ni las claves.',
          },
        ],
      });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Error al exportar.' });
    } finally {
      setExporting(false);
    }
  };

  const renderTable = (list: Account[], title: string, isCardTable: boolean) => {
    if (list.length === 0) return null;
    return (
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <h3 className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 text-sm">
          {title}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[780px]">
            <thead className="bg-slate-100 text-slate-600">
              <tr>
                <th className="text-left font-semibold px-4 py-3">Cuenta</th>
                <th className="text-left font-semibold px-4 py-3">Tipo</th>
                <th className="text-right font-semibold px-4 py-3">
                  {isCardTable ? 'Consumo' : 'Saldo'}
                </th>
                {isCardTable && (
                  <>
                    <th className="text-right font-semibold px-4 py-3">Límite</th>
                    <th className="text-right font-semibold px-4 py-3">Disponible</th>
                    <th className="text-center font-semibold px-4 py-3">Corte / Pago</th>
                  </>
                )}
                {!isCardTable && <th className="text-left font-semibold px-4 py-3">Desde</th>}
                <th className="text-right font-semibold px-4 py-3">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((a) => {
                const b = bal(a.id);
                const saldo = Number(b?.balance_usd ?? a.opening_balance_usd ?? 0);
                const disp = b?.available_usd;
                const sobregiro = a.credit_limit_usd != null && disp != null && disp < 0;
                return (
                  <tr key={a.id} className={`hover:bg-slate-50 ${!a.is_active ? 'opacity-55' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-800">
                        {a.name}
                        {a.last4 && <span className="text-slate-400 font-normal"> ···· {a.last4}</span>}
                      </div>
                      {a.bank_name && <div className="text-xs text-slate-400">{a.bank_name}</div>}
                      {!a.is_active && (
                        <span className="text-[10px] uppercase tracking-wide font-bold text-slate-500">
                          Inactiva
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {ACCOUNT_KIND_LABEL[a.kind] ?? a.kind}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-semibold ${
                        isCardTable ? 'text-slate-800' : saldo < 0 ? 'text-red-600' : 'text-emerald-700'
                      }`}
                    >
                      {fmtUSD(saldo)}
                    </td>
                    {isCardTable && (
                      <>
                        <td className="px-4 py-3 text-right text-slate-600">
                          {a.credit_limit_usd != null ? fmtUSD(a.credit_limit_usd) : '—'}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-semibold ${
                            sobregiro ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {disp != null ? fmtUSD(disp) : '—'}
                        </td>
                        <td className="px-4 py-3 text-center text-slate-600">
                          {a.statement_day ?? '—'} / {a.due_day ?? '—'}
                        </td>
                      </>
                    )}
                    {!isCardTable && (
                      <td className="px-4 py-3 text-slate-500 text-xs">
                        {formatDate(a.opening_balance_date)}
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          className={btnSecondary}
                          onClick={() => {
                            setEditing(a);
                            setModalOpen(true);
                          }}
                        >
                          Editar
                        </button>
                        <button className={btnSecondary} onClick={() => toggleActive(a)}>
                          {a.is_active ? 'Desactivar' : 'Reactivar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <FinShell
      title="Cuentas y tarjetas"
      subtitle="Bancos, Zelle, efectivo en caja y tarjetas de crédito en un solo lugar."
      actions={
        <>
          <button onClick={handleExport} disabled={exporting} className={btnSecondary}>
            {exporting ? 'Exportando…' : '📥 Exportar a .xlsx'}
          </button>
          <button
            className={btnPrimary}
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          >
            + Nueva cuenta
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <FinNotice notice={notice} onClose={() => setNotice(null)} />

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center rounded-lg border border-slate-200 bg-white p-1 text-sm font-medium">
            {(['negocio', 'personal'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-md transition-colors cursor-pointer ${
                  tab === t ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t === 'negocio' ? 'Del negocio' : 'Personales'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded border-slate-300"
            />
            Ver inactivas
          </label>
        </div>

        {tab === 'personal' && (
          <p className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
            Lo personal nunca entra en los reportes del negocio. Esta pestaña existe para que el
            dinero de la tienda y el tuyo no se mezclen.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FinStatCard
            label="Efectivo y bancos"
            value={fmtUSD(totals.disponible)}
            tone={totals.disponible < 0 ? 'red' : 'emerald'}
            sub="Lo que hay disponible ahora"
          />
          <FinStatCard
            label="Deuda en tarjetas"
            value={fmtUSD(totals.deuda)}
            tone={totals.deuda > 0 ? 'amber' : 'default'}
            sub="Consumo acumulado"
          />
          <FinStatCard label="Cupo disponible" value={fmtUSD(totals.cupo)} sub="Límite menos consumo" />
        </div>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">Cargando cuentas…</div>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200">
            <EmptyState
              title={
                tab === 'personal'
                  ? 'No hay cuentas personales registradas.'
                  : 'Todavía no hay cuentas ni tarjetas.'
              }
              hint={
                tab === 'personal'
                  ? undefined
                  : 'Carga las que usas de verdad con su saldo de hoy, para que los números digan la verdad desde el primer día.'
              }
            />
          </div>
        ) : (
          <div className="space-y-5">
            {renderTable(cash, 'Cuentas y efectivo', false)}
            {renderTable(cards, 'Tarjetas de crédito', true)}
          </div>
        )}

        <p className="text-xs text-slate-400">
          De las tarjetas se guardan solo el alias, el banco y los últimos 4 dígitos. Nunca el número
          completo, el CVV ni las claves.
        </p>
      </div>

      <AccountFormModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        account={editing}
        defaultPersonal={tab === 'personal'}
        onSaved={handleSaved}
      />
    </FinShell>
  );
}
