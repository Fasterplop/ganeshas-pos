export default function FinPlaceholder({
  section,
  phase,
  bullets,
}: {
  section: string;
  phase: string;
  bullets: string[];
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 max-w-2xl">
      <span className="inline-block text-[10px] font-bold uppercase tracking-widest text-teal-700 bg-teal-50 px-2 py-1 rounded">
        {phase}
      </span>
      <h2 className="text-lg font-bold text-slate-800 mt-3 mb-1">{section}</h2>
      <p className="text-sm text-slate-500 mb-4">
        Esta sección todavía no está construida. El esquema de base de datos que necesita ya está
        aplicado, así que cuando llegue no habrá que migrar de nuevo ni recargar datos.
      </p>
      <ul className="text-sm text-slate-600 space-y-1.5 list-disc list-inside">
        {bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </div>
  );
}
