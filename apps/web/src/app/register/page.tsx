import { redirect } from 'next/navigation';

/** O cadastro público foi desativado: as contas são criadas pela administração ou por convite. */
export default function RegisterPage() {
  redirect('/login');
}
