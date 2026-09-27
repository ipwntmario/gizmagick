import { useEffect, useRef, useState } from "react";
import TerminalCursorEffect from "./TerminalCursorEffect";

const POINTER_QUERY = "(hover: hover) and (pointer: fine)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export default function CursorEffect({ enabled, effect, themeId }) {
  const canvasRef = useRef(null);
  const [motionAllowed, setMotionAllowed] = useState(() =>
    typeof window !== "undefined"
      && window.matchMedia(POINTER_QUERY).matches
      && !window.matchMedia(REDUCED_MOTION_QUERY).matches
  );

  useEffect(() => {
    const pointer = window.matchMedia(POINTER_QUERY);
    const reducedMotion = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setMotionAllowed(pointer.matches && !reducedMotion.matches);
    pointer.addEventListener("change", update);
    reducedMotion.addEventListener("change", update);
    update();
    return () => {
      pointer.removeEventListener("change", update);
      reducedMotion.removeEventListener("change", update);
    };
  }, []);

  const active = enabled && effect === "wand" && motionAllowed;

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!context) return undefined;

    const castle = themeId === "castle-torchlit";
    const particles = [];
    const position = { x: 0, y: 0, visible: false };
    let frame = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (position.visible) requestFrame();
    };

    const drawGlow = () => {
      const { x, y } = position;
      const halo = context.createRadialGradient(x, y, 0, x, y, castle ? 37 : 31);
      halo.addColorStop(0, castle ? "rgba(255, 255, 255, .72)" : "rgba(255, 255, 255, .68)");
      halo.addColorStop(.18, castle ? "rgba(174, 226, 255, .48)" : "rgba(92, 164, 240, .42)");
      halo.addColorStop(.55, castle ? "rgba(88, 175, 255, .21)" : "rgba(71, 125, 222, .2)");
      halo.addColorStop(1, "rgba(69, 139, 236, 0)");
      context.fillStyle = halo;
      context.beginPath();
      context.arc(x, y, castle ? 37 : 31, 0, Math.PI * 2);
      context.fill();
    };

    const draw = (now) => {
      frame = 0;
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (!position.visible) return;

      // The ordinary system cursor remains on top of this non-interactive canvas.
      drawGlow();
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        const progress = (now - particle.born) / particle.life;
        if (progress >= 1) {
          particles.splice(index, 1);
          continue;
        }
        const x = particle.x + particle.vx * progress;
        const y = particle.y + particle.vy * progress + 10 * progress * progress;
        const radius = particle.radius * (1 - progress * .55);
        context.globalAlpha = (1 - progress) ** 1.5;
        context.fillStyle = particle.blue
          ? (castle ? "#91d7ff" : "#4d94ec")
          : "#ffffff";
        context.shadowColor = castle ? "#72bdff" : "#579cfa";
        context.shadowBlur = 9;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        if (particle.star) {
          context.strokeStyle = context.fillStyle;
          context.lineWidth = .8;
          context.beginPath();
          context.moveTo(x - radius * 2.5, y);
          context.lineTo(x + radius * 2.5, y);
          context.moveTo(x, y - radius * 2.5);
          context.lineTo(x, y + radius * 2.5);
          context.stroke();
        }
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
      if (particles.length) requestFrame();
    };

    function requestFrame() {
      if (!frame) frame = window.requestAnimationFrame(draw);
    }

    const onPointerMove = (event) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
      const { clientX: x, clientY: y } = event;
      if (position.visible) {
        const dx = x - position.x;
        const dy = y - position.y;
        const distance = Math.hypot(dx, dy);
        const count = Math.min(8, Math.floor(distance / 6));
        const now = performance.now();
        for (let index = 0; index < count; index += 1) {
          const fraction = (index + Math.random()) / count;
          particles.push({
            x: position.x + dx * fraction + (Math.random() - .5) * 9,
            y: position.y + dy * fraction + (Math.random() - .5) * 9,
            vx: (Math.random() - .5) * 38 - dx / distance * 18,
            vy: (Math.random() - .5) * 38 - dy / distance * 18,
            born: now,
            life: 380 + Math.random() * 380,
            radius: .7 + Math.random() * 1.5,
            blue: Math.random() < .46,
            star: Math.random() < .22,
          });
        }
        if (particles.length > 100) particles.splice(0, particles.length - 100);
      }
      position.x = x;
      position.y = y;
      position.visible = true;
      requestFrame();
    };

    const hide = () => {
      position.visible = false;
      particles.length = 0;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    };
    const onPointerOut = (event) => { if (!event.relatedTarget) hide(); };
    const onVisibilityChange = () => { if (document.hidden) hide(); };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, themeId]);

  if (enabled && effect === "terminal" && motionAllowed) return <TerminalCursorEffect />;
  return active ? <canvas ref={canvasRef} className="cursor-effect" aria-hidden="true" /> : null;
}
