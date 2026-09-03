// Logo oficial de Cashea (símbolo "C" sobre fondo amarillo), servido desde /public/cashea.png.
// Se usa como icono del método de pago Cashea en el POS y en el dashboard.
export default function CasheaLogo({ className = 'w-6 h-6 rounded-md' }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/cashea.png" alt="Cashea" title="Cashea" className={className} draggable={false} />;
}
