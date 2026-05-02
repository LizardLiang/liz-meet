// src/lib/toast-context.ts
// Toast context — separate from the ToastProvider component for fast-refresh compatibility.

import { createContext, useContext } from 'react';

export interface Toast {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
}

export const ToastContext = createContext<{
  addToast: (toast: Omit<Toast, 'id'>) => void;
}>({ addToast: () => void 0 });

export function useToast() {
  return useContext(ToastContext);
}
