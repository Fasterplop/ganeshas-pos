import { requireRole } from '@/lib/auth/guard';

// Guard de Usuarios: solo el dueño.
//
// La página ya redirigía desde el cliente (users/page.tsx), pero eso alcanza a
// montar la pantalla antes de irse. Acá no se pinta nada.
export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  await requireRole(['owner']);
  return <>{children}</>;
}
