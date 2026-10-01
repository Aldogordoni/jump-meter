import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'measure', loadComponent: () => import('./measure/measure').then((m) => m.Measure), title: 'Measure · Jump Meter' },
  { path: 'history', loadComponent: () => import('./history/history').then((m) => m.History), title: 'History · Jump Meter' },
  { path: 'setup', loadComponent: () => import('./setup/setup').then((m) => m.Setup), title: 'Setup · Jump Meter' },
  { path: '', pathMatch: 'full', redirectTo: 'measure' },
  { path: '**', redirectTo: 'measure' },
];
