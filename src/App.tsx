// src/App.tsx
// React Router v6 shell (locked decision L2).
// Routes: first-run gate + library + transcript + recording + settings.

import { createBrowserRouter, RouterProvider, redirect, Outlet } from 'react-router-dom';
import { rootGuard, privacyAckGuard, setupCompleteGuard } from './routes/guards.js';
import PrivacyNoticePage from './pages/PrivacyNoticePage.js';
import ApiKeySetupPage from './pages/ApiKeySetupPage.js';
import LibraryPage from './pages/LibraryPage.js';
import TranscriptPage from './pages/TranscriptPage.js';
import RecordingPage from './pages/RecordingPage.js';
import SettingsPage from './pages/SettingsPage.js';
import ToastProvider from './components/ToastProvider.js';
import ProviderUnreachableBanner from './components/ProviderUnreachableBanner.js';

function RootShell() {
  return (
    <ToastProvider>
      <ProviderUnreachableBanner />
      <Outlet />
    </ToastProvider>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    loader: rootGuard,
    element: <RootShell />,
    children: [
      { index: true, loader: () => redirect('/library') },
      { path: 'first-run/privacy',  element: <PrivacyNoticePage /> },
      { path: 'first-run/api-key',  loader: privacyAckGuard, element: <ApiKeySetupPage /> },
      { path: 'library',            loader: setupCompleteGuard, element: <LibraryPage /> },
      { path: 'session/:id',        loader: setupCompleteGuard, element: <TranscriptPage /> },
      { path: 'recording',          loader: setupCompleteGuard, element: <RecordingPage /> },
      { path: 'settings',           loader: setupCompleteGuard, element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
