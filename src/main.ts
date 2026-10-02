import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Sign-in links from Supabase land on "#access_token=…". The app uses hash routing,
// so take the tokens out of the URL before the router sees (and discards) them.
const hash = location.hash.slice(1);
if (/(^|&)(access_token|error_description)=/.test(hash)) {
  try {
    sessionStorage.setItem('jump-meter.auth-redirect', hash);
  } catch {
    /* private mode: the user can still sign in with a code */
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#/account`);
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
