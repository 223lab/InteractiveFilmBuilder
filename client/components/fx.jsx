import React, { useEffect, useRef } from 'react';

/** Text with RGB-split pseudo-element layers (see .glitch in global.css). */
export function GlitchText({ text, as: Tag = 'span', className = '', intense = false }) {
  return (
    <Tag className={`glitch ${intense ? 'glitch--intense' : ''} ${className}`} data-text={text}>
      {text}
    </Tag>
  );
}

/**
 * Countdown bar driven by requestAnimationFrame (no React re-render per frame).
 * deadline is a performance.now() timestamp.
 */
export function CountdownBar({ deadline, durationMs, className = '', showSeconds = true, onSecond }) {
  const fill = useRef(null);
  const label = useRef(null);
  const lastSec = useRef(null);
  useEffect(() => {
    if (!deadline || !durationMs) return undefined;
    let raf;
    const frame = () => {
      const left = Math.max(0, deadline - performance.now());
      const pct = Math.min(1, left / durationMs);
      if (fill.current) {
        fill.current.style.transform = `scaleX(${pct})`;
        fill.current.classList.toggle('is-critical', left < 3000);
      }
      const sec = Math.ceil(left / 1000);
      if (label.current) label.current.textContent = String(sec).padStart(2, '0');
      if (sec !== lastSec.current) {
        lastSec.current = sec;
        onSecond?.(sec);
      }
      if (left > 0) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [deadline, durationMs, onSecond]);

  return (
    <div className={`countdown ${className}`}>
      <div className="countdown__track">
        <div ref={fill} className="countdown__fill" />
      </div>
      {showSeconds && <span ref={label} className="countdown__sec">--</span>}
    </div>
  );
}

/** Low-res animated TV static on a canvas, scaled up with pixelated rendering. */
export function StaticNoise({ opacity = 0.12, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const c = canvas.getContext('2d');
    const w = (canvas.width = 160);
    const h = (canvas.height = 90);
    const img = c.createImageData(w, h);
    let raf;
    let last = 0;
    const draw = (t) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 45) return; // ~22fps reads more "analog"
      last = t;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
      }
      c.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className={`static-noise ${className}`} style={{ opacity }} aria-hidden />;
}

/**
 * Lobby → film transition: flicker, RGB split, CRT collapse to a line, black, then a
 * boot-up bloom. Timeline is stretched to the server's transition duration.
 */
export function BootTransition({ durationMs = 2800, label = 'SIGNAL ACQUIRED' }) {
  return (
    <div className="boot" style={{ '--boot-dur': `${durationMs}ms` }} aria-hidden>
      <StaticNoise opacity={0.55} className="boot__static" />
      <div className="boot__rgb" />
      <div className="boot__collapse" />
      <div className="boot__text">
        <GlitchText text={label} intense />
        <div className="boot__sub">ESTABLISHING NEURAL FEED · LEADER CONNECTED</div>
      </div>
    </div>
  );
}

/** Scanlines + vignette + subtle flicker, layered over everything on the host. */
export function CrtOverlay() {
  return (
    <>
      <div className="crt-scanlines" aria-hidden />
      <div className="crt-vignette" aria-hidden />
    </>
  );
}
