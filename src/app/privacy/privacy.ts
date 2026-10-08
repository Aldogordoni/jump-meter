import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Privacy notice and record of processing, in plain words. */
@Component({
  selector: 'app-privacy',
  imports: [RouterLink],
  template: `
    <article>
      <h1>Privacy</h1>
      <p class="lede">
        Jump Meter is a small, invite-only app. This page explains what it stores, where, who can see it, and how to get
        it back or delete it. Last updated 7 October 2026.
      </p>

      <h2>Who is responsible</h2>
      <p>
        The person who runs this copy of Jump Meter and approved your email (the admin) is the data controller. If you
        have a question or want something changed, ask them directly.
      </p>

      <h2>Without an account</h2>
      <p>
        Everything stays on your phone: your jumps, settings and video clips are kept in the browser's own storage. No
        cookies, no analytics, no advertising. Videos are analysed on your phone by the on-device pose model; frames are
        never uploaded for analysis.
      </p>

      <h2>With an account</h2>
      <table>
        <caption class="sr-only">What is stored in the cloud</caption>
        <thead>
          <tr><th scope="col">What</th><th scope="col">Why</th><th scope="col">How long</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Email address, password (hashed), optional authenticator app</td>
            <td>Signing in; only approved emails can create an account</td>
            <td>Until you delete your account</td>
          </tr>
          <tr>
            <td>Username, display name, profile picture</td>
            <td>Showing who you are to squad mates you choose to join</td>
            <td>Until you change or delete them</td>
          </tr>
          <tr>
            <td>Jumps: results, dates, tags, notes, analysis details</td>
            <td>Backup and history across your devices</td>
            <td>Until you delete them or your account</td>
          </tr>
          <tr>
            <td>Video clips and thumbnails of your jumps</td>
            <td>Watching back and sharing with a coach, if you choose</td>
            <td>Until you delete them; Setup can delete old clips automatically</td>
          </tr>
          <tr>
            <td>Settings: units, height, body mass, goals, plan</td>
            <td>Calculations (power, frame-rate check) and keeping settings in step</td>
            <td>Until you delete your account</td>
          </tr>
          <tr>
            <td>Squad memberships, comments</td>
            <td>Coaching and leaderboards you opt into</td>
            <td>Until you leave, delete them, or delete your account</td>
          </tr>
          <tr>
            <td>Error reports (message, page, app version, browser)</td>
            <td>Fixing bugs. Emails and tokens are removed first</td>
            <td>Cleared by the admin, normally within 30 days</td>
          </tr>
        </tbody>
      </table>
      <p>
        The lawful basis is your consent (you asked for an account and choose what to share) and the admin's legitimate
        interest in keeping the app working and secure.
      </p>

      <h2>Where it's kept</h2>
      <ul>
        <li><strong>Supabase</strong> (database, file storage and sign-in), hosted in the EU (Ireland, AWS eu-west-1).</li>
        <li><strong>GitHub Pages</strong> serves the app's files. It sees your IP address like any web host, but no app data.</li>
        <li>
          <strong>Google</strong> may serve the pose model file the first time you use auto-detect. Only the file is
          downloaded; nothing about you is sent.
        </li>
      </ul>

      <h2>Who can see your data</h2>
      <ul>
        <li><strong>You.</strong> Database rules let each person read only their own jumps, clips and settings.</li>
        <li>
          <strong>Coaches of a squad you joined</strong>, only while you have "Let this squad's coaches see my jumps"
          turned on. Turning it off stops their access at once.
        </li>
        <li><strong>Squad mates</strong> see your name and picture, and your best results only if you opt into the leaderboard.</li>
        <li>
          <strong>The admin</strong> can see the list of approved emails and the error reports. As the owner of the
          Supabase project they could also open the database directly, so only join if you trust them.
        </li>
      </ul>

      <h2>Your rights</h2>
      <ul>
        <li><strong>Get a copy:</strong> <a routerLink="/setup">Setup</a> › Export backup (jumps and clips) or CSV.</li>
        <li><strong>Correct:</strong> edit any jump in History, and your profile in Account.</li>
        <li>
          <strong>Delete:</strong> <a routerLink="/account">Account</a> › Delete my cloud account removes your jumps,
          clips, settings, squads you own, memberships and comments.
        </li>
        <li><strong>Object or complain:</strong> ask the admin, or contact your national data protection authority.</li>
      </ul>

      <h2>Security</h2>
      <p>
        Traffic is encrypted, clips are in a private storage bucket reached only through short-lived links, access is
        enforced by database rules (tested automatically), and you can turn on two-step sign-in in Account.
      </p>
    </article>
  `,
  styles: `
    article {
      max-width: 44em;
    }
    .lede {
      font-size: 1.05rem;
    }
    h2 {
      margin-top: 26px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    th,
    td {
      text-align: left;
      vertical-align: top;
      padding: 8px 6px;
      border-bottom: 1px solid var(--line);
    }
    th {
      color: var(--ink-soft);
      font-weight: 600;
    }
    ul {
      padding-left: 1.2em;
      display: grid;
      gap: 6px;
    }
  `,
})
export class Privacy {}
