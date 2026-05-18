import { useEffect, useRef, useState } from "react";

interface MarqueeTextProps {
  text: string;
  className?: string;
  speedPxPerSec?: number;
}

export function MarqueeText({ text, className, speedPxPerSec = 40 }: MarqueeTextProps) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const measure = () => {
      const wrap = wrapperRef.current;
      const track = trackRef.current;
      if (!wrap || !track) return;
      const wrapW = wrap.clientWidth;
      const trackW = track.scrollWidth;
      if (trackW > wrapW + 1) {
        setOverflow(true);
        setDistance(trackW - wrapW + 24);
      } else {
        setOverflow(false);
        setDistance(0);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [text]);

  const duration = distance > 0 ? Math.max(4, distance / speedPxPerSec) : 0;

  return (
    <span
      ref={wrapperRef}
      className={`marquee-container relative inline-block overflow-hidden align-bottom ${overflow ? "" : "truncate"} ${className ?? ""}`}
      style={{ maxWidth: "100%" }}
    >
      <span
        ref={trackRef}
        className={`marquee-track ${overflow ? "is-overflow" : ""}`}
        style={
          overflow
            ? ({
                ["--marquee-distance" as string]: `${distance}px`,
                ["--marquee-duration" as string]: `${duration}s`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
