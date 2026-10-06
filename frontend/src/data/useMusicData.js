import { useEffect, useState } from "react";
import { gizmagickRepository } from './gizmagickRepository.js';

export function useMusicData() {
  const [tracks, setTracks] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const catalog = await gizmagickRepository.loadCatalog();
        if (!alive) return;
        setTracks(catalog);
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return { tracks, loading, error };
}
