import { useCallback, useEffect, useState } from "react";
import { api, message } from "./api";

export function useResource<T>(path: string, revision = 0) {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ error: message(error), loading: false });
      });
    return () => controller.abort();
  }, [path, revision, retry]);
  return { ...state, reload };
}
