import { useCallback, useEffect, useState } from 'react';

interface VerticalResizeHandleProps {
  onResize: (height: number) => void;
  minHeight?: number;
  maxHeight?: number;
}

export function VerticalResizeHandle({ onResize, minHeight = 200, maxHeight = 600 }: VerticalResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [startY, setStartY] = useState(0);
  const [startHeight, setStartHeight] = useState(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setStartY(e.clientY);
    // Get the current height from the parent element
    const parent = (e.target as HTMLElement).previousElementSibling;
    if (parent) {
      setStartHeight(parent.getBoundingClientRect().height);
    }
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      const newHeight = Math.min(Math.max(startHeight + delta, minHeight), maxHeight);
      onResize(newHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, startY, startHeight, minHeight, maxHeight, onResize]);

  return (
    <div
      className={`vertical-resize-handle ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
    />
  );
}
