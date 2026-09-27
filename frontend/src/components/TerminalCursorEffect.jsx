import { useEffect, useRef } from "react";

const CHARACTERS = "01@#$%&*+-=<>?/\\[]{}";
const COLUMN_WIDTH = 14;
const ROW_HEIGHT = 17;
const MIN_RADIUS = 56;
const MAX_RADIUS = 132;
const randomCharacter = () => CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)];

export default function TerminalCursorEffect({ containerRef }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!context) return undefined;
    const surface = containerRef?.current;
    const target = surface || window;
    const size = () => ({ width: surface?.clientWidth || window.innerWidth, height: surface?.clientHeight || window.innerHeight });

    const pointer = { x: 0, y: 0, visible: false, lastMove: 0, radius: MAX_RADIUS, targetRadius: MAX_RADIUS };
    const glyphs = new Map();
    let frame = 0;
    let lastFrame = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(size().width * ratio);
      canvas.height = Math.round(size().height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      glyphs.clear();
      requestFrame();
    };

    const visibleCells = () => {
      const cells = [];
      const radius = pointer.radius;
      const firstColumn = Math.floor((pointer.x - radius) / COLUMN_WIDTH);
      const lastColumn = Math.ceil((pointer.x + radius) / COLUMN_WIDTH);
      const firstRow = Math.floor((pointer.y - radius) / ROW_HEIGHT);
      const lastRow = Math.ceil((pointer.y + radius) / ROW_HEIGHT);
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const x = column * COLUMN_WIDTH + COLUMN_WIDTH / 2;
          const y = row * ROW_HEIGHT + ROW_HEIGHT / 2;
          const distance = Math.hypot(x - pointer.x, y - pointer.y);
          if (distance > radius) continue;
          const key = `${column}:${row}`;
          if (!glyphs.has(key)) glyphs.set(key, randomCharacter());
          cells.push({ key, x, y, distance });
        }
      }
      if (glyphs.size > 900) {
        const visible = new Set(cells.map(({ key }) => key));
        for (const key of glyphs.keys()) if (!visible.has(key)) glyphs.delete(key);
      }
      return cells;
    };

    const draw = (now) => {
      frame = 0;
      const elapsed = lastFrame ? Math.min(now - lastFrame, 50) : 16;
      lastFrame = now;
      context.clearRect(0, 0, size().width, size().height);
      if (!pointer.visible) return;

      if (now - pointer.lastMove > 70) pointer.targetRadius = MAX_RADIUS;
      pointer.radius += (pointer.targetRadius - pointer.radius) * Math.min(1, elapsed / 190);

      const halo = context.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, pointer.radius);
      halo.addColorStop(0, "rgba(15, 87, 34, .16)");
      halo.addColorStop(1, "rgba(15, 87, 34, 0)");
      context.fillStyle = halo;
      context.beginPath();
      context.arc(pointer.x, pointer.y, pointer.radius, 0, Math.PI * 2);
      context.fill();

      context.font = '12px "Cascadia Mono", Consolas, monospace';
      context.textAlign = "center";
      context.textBaseline = "middle";
      for (const cell of visibleCells()) {
        const strength = 1 - cell.distance / pointer.radius;
        context.fillStyle = `rgba(91, 255, 126, ${(.12 + .75 * strength * strength).toFixed(3)})`;
        context.fillText(glyphs.get(cell.key), cell.x, cell.y);
      }
      if (Math.abs(pointer.radius - pointer.targetRadius) > .5 || now - pointer.lastMove < 80) requestFrame();
    };

    function requestFrame() {
      if (!frame) frame = window.requestAnimationFrame(draw);
    }

    const onPointerMove = (event) => {
      if (!surface && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const now = performance.now();
      const bounds = surface?.getBoundingClientRect();
      const x = event.clientX - (bounds?.left || 0);
      const y = event.clientY - (bounds?.top || 0);
      if (pointer.visible) {
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const speed = distance / Math.max(now - pointer.lastMove, 1);
        pointer.targetRadius = Math.max(MIN_RADIUS, MAX_RADIUS - speed * 34);
      }
      pointer.x = x;
      pointer.y = y;
      pointer.lastMove = now;
      pointer.visible = true;
      requestFrame();
    };

    const changeCharacters = () => {
      if (!pointer.visible) return;
      const cells = visibleCells();
      for (const { key } of cells) if (Math.random() < .14) glyphs.set(key, randomCharacter());
      requestFrame();
    };

    const hide = () => {
      pointer.visible = false;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastFrame = 0;
      context.clearRect(0, 0, size().width, size().height);
    };
    const onPointerOut = (event) => { if (!event.relatedTarget) hide(); };
    const onVisibilityChange = () => { if (document.hidden) hide(); };

    resize();
    const interval = window.setInterval(changeCharacters, 100);
    const observer = surface ? new ResizeObserver(resize) : null;
    if (surface) observer.observe(surface);
    window.addEventListener("resize", resize);
    target.addEventListener("pointermove", onPointerMove);
    if (surface) {
      target.addEventListener("pointerdown", onPointerMove);
      target.addEventListener("pointerleave", hide);
    } else target.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      target.removeEventListener("pointermove", onPointerMove);
      if (surface) {
        target.removeEventListener("pointerdown", onPointerMove);
        target.removeEventListener("pointerleave", hide);
      } else target.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [containerRef]);

  return <canvas ref={canvasRef} className={`cursor-effect cursor-effect--terminal ${containerRef ? "cursor-effect--preview" : ""}`} aria-hidden="true" />;
}
