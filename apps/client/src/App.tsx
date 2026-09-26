// Full-window <canvas> placeholder. WebGPU/Three.js/Three Flatland
// initialization is deferred to the M0 rendering probe — this component only
// establishes the mount point and layout the probe will attach to.
export function App() {
  return (
    <>
      <canvas
        id="scene"
        style={{
          position: "fixed",
          inset: 0,
          width: "100%",
          height: "100%",
          display: "block",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          color: "#f5f5f5",
          fontFamily: "system-ui, sans-serif",
          pointerEvents: "none",
        }}
      >
        Panthea
      </div>
    </>
  );
}
