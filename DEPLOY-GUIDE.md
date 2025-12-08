# 🚀 VERCEL BACKEND DEPLOYMENT - COMPLETE GUIDE

**CRITICAL: This gets your REAL AI-powered backend live in 15 minutes!**

---

## 📋 WHAT YOU'RE DEPLOYING

This backend provides:
- ✅ **Real Claude AI** document analysis
- ✅ **PDF parsing** (extracts text from uploaded PDFs)
- ✅ **Multi-party extraction** (buyer, seller, bank details)
- ✅ **Automatic document type detection** (LOI, ICPO, KYC)
- ✅ **JSON responses** your frontend expects

**Cost:** FREE for testing, $20/month for production (Vercel Pro)

---

## ⚡ QUICK START (15 MINUTES)

### **Step 1: Get Anthropic API Key (5 mins)**

1. Go to: https://console.anthropic.com
2. Sign up (if you haven't already)
3. Click "API Keys" in sidebar
4. Click "Create Key"
5. Name it: "DDP Production"
6. **Copy the key** (starts with `sk-ant-...`)
7. **SAVE IT** - you'll need it in Step 3!

**Cost:** $5 free credit, then ~$3-8 per 1M tokens

---

### **Step 2: Install Vercel CLI (2 mins)**

Open your terminal and run:

```bash
npm install -g vercel
```

**OR** if you don't have npm:

1. Download Node.js: https://nodejs.org
2. Install it
3. Then run: `npm install -g vercel`

**Verify installation:**
```bash
vercel --version
```

Should show: `Vercel CLI 33.x.x` or similar

---

### **Step 3: Deploy Backend (5 mins)**

**3.1 Navigate to Backend Folder**

```bash
cd /path/to/VERCEL-BACKEND-DEPLOY
```

**3.2 Login to Vercel**

```bash
vercel login
```

- Opens browser
- Login with GitHub, GitLab, or email
- Returns to terminal

**3.3 Deploy!**

```bash
vercel
```

It will ask:
- **Set up and deploy?** → `Y` (Yes)
- **Which scope?** → Choose your account
- **Link to existing project?** → `N` (No)
- **What's your project's name?** → `ddp-backend` (or any name)
- **In which directory is your code located?** → `./` (just press Enter)
- **Want to override the settings?** → `N` (No)

**It will deploy and give you a URL like:**
```
https://ddp-backend-xyz123.vercel.app
```

**SAVE THIS URL!**

**3.4 Add Environment Variable**

```bash
vercel env add ANTHROPIC_API_KEY
```

- Choose: `Production`
- Paste your Anthropic API key (from Step 1)
- Press Enter

**3.5 Redeploy with Environment Variable**

```bash
vercel --prod
```

**Done! Your backend is LIVE!** 🎉

---

### **Step 4: Configure Custom Domain (5 mins)**

**4.1 Add Custom Domain in Vercel Dashboard**

1. Go to: https://vercel.com/dashboard
2. Click your project: `ddp-backend`
3. Click "Settings" tab
4. Click "Domains" in sidebar
5. Click "Add Domain"
6. Enter: `api.dudediligence.pro`
7. Click "Add"

**4.2 Configure DNS (depends on your DNS provider)**

Vercel will show you DNS records to add. Typically:

**If using Cloudflare:**
1. Go to Cloudflare dashboard
2. Select `dudediligence.pro` domain
3. Click "DNS" → "Records"
4. Add **CNAME record**:
   - Name: `api`
   - Target: `cname.vercel-dns.com`
   - Proxy status: DNS only (gray cloud)
5. Save

**If using another DNS provider:**
- Follow Vercel's instructions exactly
- Usually it's a CNAME pointing to `cname.vercel-dns.com`

**4.3 Wait for DNS** (2-10 minutes)

Check status in Vercel dashboard. When it shows ✅ green checkmark, you're done!

**Your API is now at:** `https://api.dudediligence.pro/api/analyze`

---

## 🧪 TESTING YOUR BACKEND

### **Test 1: Direct API Call**

```bash
curl -X POST https://api.dudediligence.pro/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "test.txt",
    "fileType": "text/plain",
    "fileData": "'$(echo "This is a letter of intent for 10,000 MT of sugar from ABC Corp to XYZ Ltd." | base64)'"
  }'
```

**Expected response:**
```json
{
  "success": true,
  "data": {
    "documentType": "LOI",
    "commodity": "sugar",
    "quantity": "10,000 MT",
    "buyer": { ... },
    "seller": { ... }
  }
}
```

**If you see this → Backend is working!** ✅

---

### **Test 2: From Your Website**

1. Open: https://dudediligence.pro
2. Upload a test PDF (LOI, ICPO, or KYC document)
3. Click "Run The Dude"
4. **Should see:** Real AI extracted data (not demo data!)
5. **Check console (F12)** → Should see API call to `api.dudediligence.pro`

**If extraction looks REAL (not demo) → SUCCESS!** ✅

---

## 🔧 TROUBLESHOOTING

### **Problem: "Module not found: @anthropic-ai/sdk"**

**Solution:** Install dependencies

```bash
cd VERCEL-BACKEND-DEPLOY
npm install
vercel --prod
```

---

### **Problem: "ANTHROPIC_API_KEY is not defined"**

**Solution:** Add environment variable

```bash
vercel env add ANTHROPIC_API_KEY
# Paste your key
vercel --prod
```

---

### **Problem: CORS errors in browser**

**Symptoms:** Console shows: `Access-Control-Allow-Origin` error

**Solution:** Check `vercel.json` has CORS headers (it should already)

If not, add this to `vercel.json`:
```json
{
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "*" }
      ]
    }
  ]
}
```

Then redeploy: `vercel --prod`

---

### **Problem: Frontend still shows demo data**

**Check these:**

1. **Is API URL correct in frontend?**
   - Open `index.html` line 1477
   - Should say: `https://api.dudediligence.pro/api/analyze`
   - If not, update it

2. **Is backend actually deployed?**
   - Visit: `https://api.dudediligence.pro/api/analyze`
   - Should show: `{"error":"Method not allowed"}` (normal for GET request)

3. **Is API key set?**
   - Run: `vercel env ls`
   - Should show: `ANTHROPIC_API_KEY` in Production

4. **Check browser console (F12)**
   - Upload document
   - Click "Run The Dude"
   - Check Network tab
   - See the API call?
   - What's the response?

---

## 💰 COSTS

### **Vercel:**
- **Free tier:** 100GB bandwidth/month (enough for testing)
- **Pro:** $20/month (unlimited bandwidth, custom domains)

### **Anthropic Claude API:**
- **Free:** $5 credit (good for ~50-200 analyses)
- **Pay-as-you-go:** ~$3-8 per 1M tokens
- **Typical cost per analysis:** $0.01 - 0.05

### **Total Monthly Cost (estimated):**
- **Testing (< 100 analyses/month):** $0 (free tiers)
- **Light production (500 analyses/month):** $20 (Vercel) + $5-25 (Claude) = **$25-45/month**
- **Heavy production (5000 analyses/month):** $20 (Vercel) + $50-250 (Claude) = **$70-270/month**

---

## 🎯 SUCCESS CHECKLIST

Before telling customers it's ready:

- [ ] Vercel account created
- [ ] Anthropic API key obtained
- [ ] Backend deployed to Vercel
- [ ] Environment variable added (ANTHROPIC_API_KEY)
- [ ] Custom domain configured (api.dudediligence.pro)
- [ ] DNS records added and propagated
- [ ] Tested with curl command (works)
- [ ] Tested from website (real AI data appears)
- [ ] No CORS errors in browser console
- [ ] PDF upload works
- [ ] Text file upload works
- [ ] Extraction quality is good (90%+ accurate)

**If ALL checked → YOU'RE LIVE!** 🎉

---

## 📊 MONITORING & DEBUGGING

### **View Logs:**

```bash
vercel logs
```

OR in dashboard:
1. https://vercel.com/dashboard
2. Click project
3. Click "Deployments"
4. Click latest deployment
5. Click "Functions"
6. Click `/api/analyze`
7. See logs in real-time

### **Monitor Usage:**

**Vercel:**
- Dashboard → Analytics
- See bandwidth, function invocations, errors

**Anthropic:**
- https://console.anthropic.com
- See API usage, costs, rate limits

---

## 🚀 WHAT'S NEXT (OPTIONAL ENHANCEMENTS)

Your backend currently does:
- ✅ AI document analysis
- ✅ Multi-party extraction
- ✅ Automatic type detection

**To add later (after launch):**

1. **Database checks** (OFAC, OpenCorporates, etc.)
   - Add to `api/analyze.js`
   - Call external APIs after extraction
   - ~2-4 hours work

2. **Document fingerprinting**
   - Hash documents to detect recycled docs
   - Store hashes in database
   - ~3-5 hours work

3. **Email notifications**
   - Send report to user's email
   - Use SendGrid or similar
   - ~1-2 hours work

4. **Report storage**
   - Save reports in database (PostgreSQL/MongoDB)
   - User can view history
   - ~4-6 hours work

**But for now: LAUNCH WITH WHAT YOU HAVE!**

The AI extraction is the core value. Database checks are nice-to-have, not must-have for beta.

---

## 📞 SUPPORT

**Vercel Issues:**
- Docs: https://vercel.com/docs
- Support: https://vercel.com/support

**Anthropic Issues:**
- Docs: https://docs.anthropic.com
- Support: support@anthropic.com

**DNS/Domain Issues:**
- Check your DNS provider's docs
- Usually takes 5-60 minutes to propagate

---

## ✅ YOU'RE READY!

Follow the steps above, and in **15 minutes** you'll have:
- ✅ Real AI-powered document analysis
- ✅ Live backend at api.dudediligence.pro
- ✅ Frontend calling real API (not demo)
- ✅ Professional results for beta testers

**Don't overthink it. Just deploy and test!** 🚀

---

**Created:** December 8, 2025  
**Status:** READY TO DEPLOY ✅  
**Estimated Time:** 15 minutes  
**Difficulty:** Easy  

**LET'S GO!** 💪
