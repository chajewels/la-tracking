import { ReactNode } from 'react';
import AppSidebar from './AppSidebar';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background dark">
      <AppSidebar />
      <main className="ml-64 min-h-screen">
        <div className="p-6 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
