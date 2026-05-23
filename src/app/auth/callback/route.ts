import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Hacia dónde vamos después de validar el login (en este caso será /update-password)
  const next = searchParams.get('redirect_to') ?? '/'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Si hay un error con el código o expiró, lo mandamos al login
  return NextResponse.redirect(`${origin}/login?error=Enlace_invalido`)
}