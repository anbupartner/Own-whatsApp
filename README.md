# WhatsApp Bulk Sender

A small web app for sending a personalised WhatsApp message to a list of contacts.
It needs no npm packages, only Node.js 18 or newer. Run it on your own computer, or deploy it to Vercel.

## Run it on your computer

```
npm start
```

Open http://localhost:3000. Locally there is no login (the server only listens on 127.0.0.1) unless you set `APP_PASSWORD` in `.env`.

## How to use it

1. **Contacts:** upload a CSV or paste one. The first row is the headers and must include a `phone` column
   (`mobile`, `number` or `whatsapp` also work). Any other column, such as `name` or `city`, can be used as a placeholder.
   Numbers with 10 digits or fewer get the default country code (91) added. Duplicates are removed.
2. **Message:** write the text with placeholders like `{name}` and `{city}`. The preview shows how it looks for the first contact.
3. **Send:** pick a mode.

### Manual mode (no setup)
**Open next chat** opens `wa.me/<number>?text=<message>` in WhatsApp Web or Desktop with the message filled in.
You press Send yourself. This works with your normal WhatsApp account and suits small lists.

### Cloud API mode (automatic)
This uses Meta's official WhatsApp Business Cloud API.

1. Create an app at https://developers.facebook.com and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, copy the **access token** and the **Phone number ID**.
   For a lasting token, create a System User token in Business Settings.
3. Copy `.env.example` to `.env`, fill in both values, and restart with `npm start`.
4. Choose a message type:
   - **Template:** required to start a conversation, or when more than 24 hours have passed since the contact's last message.
     Create templates in WhatsApp Manager and wait for Meta to approve them. `hello_world` is approved by default for testing.
     Put one body parameter per line (`{{1}}`, `{{2}}` …); each line can use placeholders.
   - **Free text:** works only within 24 hours of the contact's last message to you.
5. Set the send interval (see below) and click **Start sending**. Failed rows show the API error when you hover over them.
   You can run again and only pending or failed contacts are re-sent.

**Export results** saves a CSV with the status of every contact.

## Send interval and repeating schedule (Cloud API mode)

- **Min / max gap:** after each message the app waits a random time between these values (default 5–15 seconds).
- **Pause after every N messages:** a longer break after each batch (default 60 seconds after every 20). Set N to 0 to turn it off.

### Campaigns

Campaigns can be saved in either mode. They are sent automatically only when the WhatsApp Cloud API is set up;
without it, scheduled runs are skipped, and **Load into page** puts a campaign's contacts and message back on the page
so you can send it with Manual mode. (A file attachment has to be chosen again; a link attachment is restored.)

A campaign is a saved broadcast: its own contacts, message (or template), attachment, gaps and schedule.
You can save as many campaigns as you like.

1. Load the contacts, write the message, add any attachment and set the gaps.
2. Under **Campaigns**, type a name and pick when it sends:
   **Once at** a date and time, **Every day at** a time, **Every N hours** or **Every N minutes**.
3. Click **Save campaign**. Repeat with other contacts and messages for more campaigns.

Each campaign has its own card showing its status, next run, live progress and a **History** of the last 20 events.

| Button | What it does |
|---|---|
| **Start now** | Sends the campaign to all its contacts now. If another campaign is sending, it is queued and starts right after. |
| **Stop** | Stops sending but keeps its place (for example "Stopped at 20/50"). |
| **Resume sending** | Continues a stopped run with the next contact. Nobody gets the message twice. |
| **Cancel** | Ends the run: contacts not reached yet don't get it. Also cancels a queued Start now. |
| **Pause schedule** | No new scheduled runs. A run that is sending keeps going (use Stop for that). |
| **Resume schedule** | Turns the schedule back on and works out the next run time. |
| **Export last run** | CSV with each contact's result (sent / failed and the reason). |
| **Delete** | Removes the campaign. Stop or cancel a sending run first. |

While a run is stopped, the campaign's scheduled runs are skipped (and noted in History) until you resume sending or cancel it.

**Where campaigns are saved**
- **On Vercel with Neon Postgres:** in the table `wa_kv` (one row per key; keys start with `wa:`). Browse it in Vercel → Storage → your database → **Data Editor**.
- **On Vercel with Upstash Redis:** under keys starting with `wa:`
  (`wa:campaigns` = the list, `wa:c:<id>` = a campaign, `wa:m:<id>` = its attachment, `wa:r:<id>` = a run in progress).
  You can browse them in the Upstash console (Data Browser).
- **On your computer:** in the `data/` folder next to `server.js`
  (`campaigns.json`, `c_<id>.json`, `m_<id>.json`, `r_<id>.json`).
- The browser itself keeps nothing; you can open the site on another device and see the same campaigns.

- **One at a time:** only one campaign sends at a time. If several are due together, they go one after another,
  earliest first. **Run now** on a campaign while another is sending queues it to start next.
- **One-time campaigns** are marked **Finished** after they send. To send one again, use **Run now** or save a new campaign.
- You can close the page. Locally, the server (`npm start`) has to keep running and the computer must stay awake.
  On Vercel, runs are started by a cron call; see **Deploy on Vercel**.
- Campaigns are stored in the `data/` folder locally and in Upstash Redis on Vercel, so they survive a restart.
  A run that stops halfway (restart or Vercel time limit) continues where it stopped.
- A run that is due is sent up to 6 hours late (for example after a short restart). If it is more than 6 hours late it is **not** sent;
  this is noted in the campaign's History. Change the limit with `MISSED_GRACE_HOURS`.
- To change a campaign, delete it and save a new one with the changes.
- An attached file is uploaded to WhatsApp fresh on every run, because WhatsApp media IDs expire after 30 days.
- Daily and one-time times use the time zone of the browser you saved the campaign from.
- A schedule saved with an earlier version of this app becomes a campaign called "Campaign 1".
- `data/` holds your contacts, so it is in `.gitignore`.
- Sending the same people the same message again and again quickly gets the number reported. Only message people who asked to hear from you.

## Attachments (images and documents)

In the Message card, pick a file or paste a public `https://` link to one.

| Type | Formats | Max size |
|---|---|---|
| Image | JPEG, PNG | 5 MB |
| Document | PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP… | 100 MB |

- **Cloud API, free text:** the file is uploaded to WhatsApp once when you click Start, and the same media ID is used for every contact.
  The message text is sent as the caption (up to 1024 characters). Documents keep their file name.
- **Cloud API, template:** the attachment fills the template's header, so the template must have an **IMAGE** or **DOCUMENT** header in WhatsApp Manager.
- **Manual mode:** `wa.me` links can't carry files. For an image, click **Copy image** after the chat opens and press Ctrl+V in the chat.
  For a document, attach it with the 📎 button. A link attachment is added to the end of the message instead.

## Deploy on Vercel

Vercel runs the page as static files and the API as one serverless function (`api/[...path].js`, which receives every `/api/*` request).
Because Vercel has no always-on server and no lasting disk, three things are different:

- **Login.** The site is public, so it does nothing until you set `APP_PASSWORD` (see **Users and login**).
- **Database.** Campaigns live in a database: Vercel's **Neon Postgres** or **Upstash Redis** (free plans are enough).
- **Cron.** Vercel calls `/api/cron` to start scheduled runs. One call can send for about 4½ minutes
  (`maxDuration` 300 s in `vercel.json`); a longer run pauses and continues on the next call.

### Steps

1. Go to https://vercel.com/new and import the GitHub repository. Keep the framework preset **Other**; no build command is needed.
2. In the project's **Storage** tab, connect a database (either one works):
   - **Neon (Postgres):** create or pick a Neon database and click **Connect**. Use the prefix `DATABASE` so it adds `DATABASE_URL`
     (`POSTGRES_URL` also works). The app keeps everything in one table, `wa_kv`, so a database shared with other apps is fine.
   - **Upstash for Redis:** adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`).
   If both are connected, Redis is used.
3. In **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the first admin's password, and the admin recovery password (see **Users and login**) |
   | `WHATSAPP_TOKEN` | your Cloud API access token |
   | `WHATSAPP_PHONE_NUMBER_ID` | your phone number ID |
   | `CRON_SECRET` | a long random string; Vercel sends it with every cron call |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect, then open your `*.vercel.app` address and log in.

### How often the schedule runs on Vercel

- `vercel.json` calls the cron once a day at **03:30 UTC (09:00 in India)**. The free Hobby plan allows at most one cron call a day
  and may call it any time within that hour. Schedule campaigns for **09:00** (or change the cron time in `vercel.json`
  to match your times; cron times are UTC). Campaigns due between cron calls are sent at the next call, up to 6 hours late.
- A daily call only sends about 4½ minutes' worth of messages: with 5–15 s gaps that is roughly 25–40 contacts. The rest waits for the next call.
- **For more frequent runs or bigger lists**, call the cron more often:
  - On the **Pro** plan, change the schedule in `vercel.json`, for example `"*/5 * * * *"` for every 5 minutes.
  - On the free plan, use a free external cron service (for example cron-job.org) to call
    `https://<your-app>.vercel.app/api/cron` every 5 minutes with the header `Authorization: Bearer <CRON_SECRET>`.
  Each call continues a run that paused at the time limit and then sends any campaigns that are due, so frequent calls are safe.
- **Run now** sends straight away for up to 4½ minutes; anything left continues on the next cron call.

### Other limits on Vercel
- Uploaded attachments can be at most 4.4 MB (Vercel's request size limit). For bigger documents, paste a public `https://` link instead.
- The page checks the campaigns every 5 seconds while it is open and visible; each check is one function call.

## Users and login

Everyone logs in with a **username and password**. Accounts are kept in the database (Neon or Upstash), with passwords stored only as salted scrypt hashes.

- **First admin:** log in with username `admin` and the `APP_PASSWORD` from Vercel. This creates the admin account.
  (Use `APP_USERNAME` to choose a different admin username.)
- **Adding people:** admins open the **Users** tab, enter a username, an optional full name and a role (User or Admin), and click **Add user**.
  A one-time password is shown once; give it to the person. At first login they must choose their own password.
- **Roles:** users can send and manage campaigns. Admins can also add and delete users, change roles and reset passwords.
  There is always at least one admin, and nobody can delete their own account.
- **Forgot password:** the login screen tells people to ask their admin. The admin clicks **Reset password** on that user,
  which signs them out everywhere and shows a new one-time password.
- **Admin locked out:** log in with the admin username and `APP_PASSWORD`. This recovery login then asks for a new password.
- **Change password:** from the account menu (top right). Changing a password signs out that account's other sessions.
- **Too many wrong tries:** 5 wrong passwords lock that username for 10 minutes (an admin reset unlocks it).
- Sessions last 30 days. Without a database there is only one login: `admin` + `APP_PASSWORD`.
- Locally without `APP_PASSWORD` there is no login at all (the server only listens on 127.0.0.1).

## Notes
- Only message people who have agreed to receive messages from you. Accounts that send unwanted bulk messages get reported and banned.
- With the test number, Meta only lets you send to up to 5 recipient numbers that you have verified.
- Locally the server listens on `127.0.0.1` only, and the token stays in `.env` on this computer.
  To run it on a VPS, set `HOST=0.0.0.0` and `APP_PASSWORD` (the server refuses to listen publicly without a password), and put it behind HTTPS.
