/**
 * D-02b: tiny status bar state shared by composable opts (setStatus).
 * Not a business store — shell glue only.
 */
import { ref } from 'vue';

export function useStatusBar() {
  const status = ref('');
  const setStatus = (msg: string) => {
    status.value = msg;
  };
  return { status, setStatus };
}
