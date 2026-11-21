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

### Repeat on a schedule (runs on the server)

Choose **Every day at** a time, **Every N hours** or **Every N minutes**, then click **Save schedule to server**.
The server stores the contacts (except skipped ones), each contact's filled-in message or template parameters,
the attachment and the interval settings (in the `data/` folder locally, in Upstash Redis on Vercel), and sends the whole broadcast on every run.

- You can close the page. Locally, the server (`npm start`) has to keep running and the computer must stay awake.
  On Vercel, runs are started by a cron call; see **Deploy on Vercel**.
- The saved schedule survives a restart. A run that is due is sent up to 6 hours late (for example after a short restart).
  If it is more than 6 hours late it is **not** sent; it is noted in the run log and the next run is scheduled.
  Change the limit with `MISSED_GRACE_HOURS`.
- If the server stops in the middle of a run, the run continues where it stopped once the server is back.
- Saving again replaces the schedule with whatever the page shows now.
- The saved-schedule panel shows the status, a live progress line during a run, and the last 20 runs. Its buttons:
  **Pause / Resume**, **Run now**, **Stop run**, **Export last run** (CSV of each contact's result) and **Delete**.
- An attached file is uploaded to WhatsApp fresh on every run, because WhatsApp media IDs expire after 30 days.
- If a run is still sending when the next one is due, the new one is skipped.
- Daily times use the time zone of the browser you saved the schedule from.
- `data/` holds your contacts, so it is in `.gitignore`.
- Sending the same people the same message again and again quickly gets the number reported. Use a repeat only for things they asked for, like a daily update.

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

- **Password login.** The site is public, so it does nothing until you set `APP_PASSWORD`.
- **Database.** The saved schedule lives in an Upstash Redis database (free plan is enough).
- **Cron.** Vercel calls `/api/cron` to start scheduled runs. One call can send for about 4½ minutes
  (`maxDuration` 300 s in `vercel.json`); a longer run pauses and continues on the next call.

### Steps

1. Go to https://vercel.com/new and import the GitHub repository. Keep the framework preset **Other**; no build command is needed.
2. In the project's **Storage** tab, add **Upstash for Redis** (from the Marketplace) and connect it to the project.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`), which the app reads.
3. In **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `APP_PASSWORD` | the password for logging in to the page |
   | `WHATSAPP_TOKEN` | your Cloud API access token |
   | `WHATSAPP_PHONE_NUMBER_ID` | your phone number ID |
   | `CRON_SECRET` | a long random string; Vercel sends it with every cron call |

4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect, then open your `*.vercel.app` address and log in.

### How often the schedule runs on Vercel

- `vercel.json` calls the cron once a day at **03:30 UTC (09:00 in India)**. The free Hobby plan allows at most one cron call a day
  and may call it any time within that hour. Save your schedule as **Every day at 09:00** (or change the cron time in `vercel.json`
  to match your daily time; cron times are UTC).
- A daily call only sends about 4½ minutes' worth of messages: with 5–15 s gaps that is roughly 25–40 contacts. The rest waits for the next call.
- **For more frequent runs or bigger lists**, call the cron more often:
  - On the **Pro** plan, change the schedule in `vercel.json`, for example `"*/5 * * * *"` for every 5 minutes.
  - On the free plan, use a free external cron service (for example cron-job.org) to call
    `https://<your-app>.vercel.app/api/cron` every 5 minutes with the header `Authorization: Bearer <CRON_SECRET>`.
  Each call starts a run only if one is due, or continues a run that paused at the time limit, so frequent calls are safe.
- **Run now** sends straight away for up to 4½ minutes; anything left continues on the next cron call.

### Other limits on Vercel
- Uploaded attachments can be at most 4.4 MB (Vercel's request size limit). For bigger documents, paste a public `https://` link instead.
- The page checks the saved schedule every 5 seconds while it is open and visible; each check is one function call.

## Notes
- Only message people who have agreed to receive messages from you. Accounts that send unwanted bulk messages get reported and banned.
- With the test number, Meta only lets you send to up to 5 recipient numbers that you have verified.
- Locally the server listens on `127.0.0.1` only, and the token stays in `.env` on this computer.
  To run it on a VPS, set `HOST=0.0.0.0` and `APP_PASSWORD` (the server refuses to listen publicly without a password), and put it behind HTTPS.
