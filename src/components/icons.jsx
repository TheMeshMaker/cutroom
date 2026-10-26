// Minimal stroke icons (24x24 grid).
const paths = {
  play: "M7 5l12 7-12 7z",
  pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  stepBack: "M18 6l-8 6 8 6zM7 6v12",
  stepFwd: "M6 6l8 6-8 6zM17 6v12",
  split: "M12 3v18M7 8l-3 4 3 4M17 8l3 4-3 4",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  bleep: "M4 12h2l2-6 3 12 3-9 2 3h4",
  zoom: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3",
  redo: "M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3",
  export: "M12 15V3M7 8l5-5 5 5M5 14v6h14v-6",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7h6l2 2h10v10H3z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
  music: "M9 18V6l10-2v12M9 18a3 3 0 11-6 0 3 3 0 016 0zM19 16a3 3 0 11-6 0 3 3 0 016 0z",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
  eyeOff: "M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.6 6.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004.4-1",
  volume: "M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
  magnet: "M6 3v8a6 6 0 0012 0V3h-4v8a2 2 0 01-4 0V3zM6 7h4M14 7h4",
  pause2: "M9 6v12M15 6v12",
  scissors: "M6 6a3 3 0 100 .01M6 18a3 3 0 100 .01M8.5 8.5L20 20M8.5 15.5L20 4",
  capcut: "M4 6l8 6-8 6zM12 6l8 6-8 6z",
  fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  diamond: "M12 3l9 9-9 9-9-9z",
};

export default function Icon({ name, size = 16, className = "" }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} fill={name === "play" || name === "diamond" ? "currentColor" : "none"} />
    </svg>
  );
}
