# QuickCompare — Android Cloud Deploy (No PC Needed)

Deploy this entire folder from your Android phone using Chrome, then pin it to your Home Screen like an app.

## 4-Step Android Setup
1. **Unzip this file on Android** (use the built-in Files app → tap the zip → Extract).
2. **Upload to GitHub from Chrome:**
   - Open `github.com` in Chrome, sign in, tap **+** → **New repository** (name it `quickcompare-live`, keep it Public or Private).
   - Tap **uploading an existing file** and upload all extracted files (`Dockerfile`, `render.yaml`, `package.json`, `server.js`, and `public/index.html` inside a `public` folder) → tap **Commit changes**.
3. **Deploy on Render from Chrome:**
   - Open `render.com` in Chrome → sign in with GitHub.
   - Tap **New +** → **Web Service** → select your `quickcompare-live` repo.
   - Render automatically detects the `Dockerfile` → choose the **Free** plan → tap **Create Web Service**.
   - Wait ~3–5 minutes for the build to finish. Render gives you a link like `https://quickcompare-live.onrender.com`.
4. **Install as an App on Android:**
   - Open your Render link in Chrome on Android.
   - Tap the **⋮** menu (top right) → **Add to Home screen** → **Install / Add**.

## Using It on Your Phone
- Tap **Change** on JioMart, Blinkit, or Flipkart Minutes to set a separate pincode/locality for each platform (saved automatically on your phone).
- Type any product (e.g., `dove`) and tap **Search Live** to fetch all matching results from all three platforms in parallel.
- *Note:* Free cloud instances sleep after 15 minutes of inactivity, so the first search of the day may take ~30 seconds to wake up. Also, some platforms occasionally block datacenter IPs; if a platform returns 0 live items, use the one-tap **Live pages** buttons to view it directly.
