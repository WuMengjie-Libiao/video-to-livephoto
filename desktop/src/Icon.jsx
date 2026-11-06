export default function Icon({ name, size = 18 }) {
  const shapes = {
    live: <><circle cx="12" cy="12" r="9" strokeDasharray="1 3" strokeLinecap="round" /><circle cx="12" cy="12" r="5.8" /><circle cx="12" cy="12" r="2.5" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    sound: <><path d="m11 5-5 4H3v6h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
    mute: <><path d="m11 5-5 4H3v6h3l5 4zM16 9l5 6m0-6-5 6" /></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    check: <path d="m5 12 4 4L19 6" />,
    photo: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8" cy="9" r="1.5" /><path d="m3 16 5-4 4 3 4-5 5 6" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3h.01" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}
