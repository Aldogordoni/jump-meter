import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'measure', loadComponent: () => import('./measure/measure').then((m) => m.Measure), title: 'Measure · Jump Meter' },
  { path: 'history', loadComponent: () => import('./history/history').then((m) => m.History), title: 'History · Jump Meter' },
  { path: 'train', loadComponent: () => import('./train/train').then((m) => m.Train), title: 'Train · Jump Meter' },
  { path: 'setup', loadComponent: () => import('./setup/setup').then((m) => m.Setup), title: 'Setup · Jump Meter' },
  { path: 'account', loadComponent: () => import('./account/account').then((m) => m.Account), title: 'Account · Jump Meter' },
  { path: 'admin', loadComponent: () => import('./admin/admin').then((m) => m.Admin), title: 'Approved emails · Jump Meter' },
  { path: '', pathMatch: 'full', redirectTo: 'measure' },
  { path: '**', redirectTo: 'measure' },
];
