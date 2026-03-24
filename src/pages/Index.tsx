import { Navigate } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';

export default function Index() {
  return <Navigate to={ROUTES.DASHBOARD} replace />;
}
