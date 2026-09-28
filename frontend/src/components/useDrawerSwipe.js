import { useRef, useState } from "react";

export default function useDrawerSwipe(direction, onClose) {
  const start = useRef(null);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const finish = () => {
    if (!start.current) return;
    const distance = offset;
    start.current = null;
    setDragging(false);
    setOffset(0);
    if (distance > 72) onClose();
    if (distance > 10) {
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
    }
  };

  return {
    dragging,
    style: offset ? { transform: `translateX(${direction === "left" ? -offset : offset}px)` } : undefined,
    onPointerDown(event) {
      if (event.pointerType !== "touch" || event.target.closest("input, select, textarea")) return;
      start.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    },
    onPointerMove(event) {
      if (start.current?.pointerId !== event.pointerId) return;
      const deltaX = (event.clientX - start.current.x) * (direction === "left" ? -1 : 1);
      const deltaY = Math.abs(event.clientY - start.current.y);
      if (!dragging && (deltaX < 10 || deltaX < deltaY * 1.2)) return;
      if (!dragging) event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setOffset(Math.max(0, deltaX));
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onClickCapture(event) {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
