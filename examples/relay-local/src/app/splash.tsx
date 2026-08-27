export default function Splash() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#101216",
        color: "#f7f3ea",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 520, padding: 32 }}>
        <p
          style={{
            color: "#a8ffcb",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          Preparing local database
        </p>
        <h1 style={{ fontSize: 48, lineHeight: 1, margin: "16px 0" }}>
          Applying Drizzle migrations before React mounts.
        </h1>
        <p style={{ color: "rgba(247, 243, 234, 0.68)", fontSize: 18 }}>
          Relay stays on the main thread. The local GraphQL worker opens OPFS
          SQLite, applies migrations, seeds data, then Crucible mounts the app.
        </p>
      </div>
    </div>
  );
}
