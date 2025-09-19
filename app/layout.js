export const metadata = { title: "Ghostbox TCI (MVP radio)", description: "Lecture radio live — étape 1" };

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body style={{ margin: 0, background: "#0b0b10", color: "#eae7f5", fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
