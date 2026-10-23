'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';

/** Campo de senha com botão para mostrar/ocultar o que está sendo digitado. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <input {...props} type={show ? 'text' : 'password'} autoCapitalize="none" spellCheck={false} />
      <button type="button" className="pw-eye" onClick={() => setShow((v) => !v)} aria-pressed={show} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'} title={show ? 'Ocultar senha' : 'Mostrar senha'}>
        {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
      </button>
    </span>
  );
}
