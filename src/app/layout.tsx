// public: the root shell; renders no data
import './ui/knotwork.css';
export const metadata = { title: 'Knotwork' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
