import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Junta classes (usado pelos componentes do Magic UI). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
