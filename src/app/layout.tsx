import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// El POS se usa en el telefono escaner (SVANTTO Android 13) desde
// /consultar-precio, y la propuesta promete poder agregarlo a la pantalla de
// inicio como un icono. Con el manifest, Chrome lo instala con el logo de la
// tienda en vez de una captura generica; sin viewport, la pagina se veria
// alejada y el texto diminuto.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f5c5c",
};

export const metadata: Metadata = {
  title: "Ganesha Store",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Ganesha POS", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  description: "Sistema interno de control de inventario, registros y reportes",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
