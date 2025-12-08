# 🎯 DDP BACKEND - ONE-PAGE QUICK REFERENCE

**Print this page and keep it handy!**

---

## ⚡ DEPLOYMENT (15 MINUTES)

### **Prerequisites:**
- Node.js installed (https://nodejs.org)
- Anthropic API key (https://console.anthropic.com)

### **Commands:**
```bash
# Install Vercel CLI
npm install -g vercel

# Navigate to backend folder
cd VERCEL-BACKEND-DEPLOY

# Deploy
vercel

# Add API key
vercel env add ANTHROPIC_API_KEY
# (paste your key when prompted)

# Redeploy with key
vercel --prod
```

### **Configure Domain:**
1. Vercel Dashboard → Project → Settings → Domains
2. Add: `api.dudediligence.pro`
3. Add CNAME in your DNS: `api` → `cname.vercel-dns.com`
4. Wait 5-10 minutes for DNS

---

## 🧪 TESTING

### **Test 1: API is live**
```bash
curl https://api.dudediligence.pro/api/analyze
```
**Expected:** `{"error":"Method not allowed"}` ✅

### **Test 2: AI works**
```bash
curl -X POST https://api.dudediligence.pro/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"fileName":"test.txt","fileType":"text/plain","fileData":"VGVzdA=="}'
```
**Expected:** `{"success":true,"data":{...}}` ✅

### **Test 3: Website works**
1. Visit: https://dudediligence.pro
2. Upload PDF
3. Click "Run The Dude"
4. See REAL AI data (not demo) ✅

---

## 🐛 TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| "Module not found" | `npm install && vercel --prod` |
| "API key not defined" | `vercel env add ANTHROPIC_API_KEY` |
| CORS error | Check `vercel.json` has CORS headers |
| Slow response | Normal for large PDFs (5-10 sec) |
| Poor extraction | Improve prompts in `api/analyze.js` |

---

## 📊 MONITORING

**View logs:**
```bash
vercel logs --follow
```

**Check usage:**
- Vercel: https://vercel.com/dashboard
- Anthropic: https://console.anthropic.com

---

## 💰 COSTS

**FREE Tier:**
- Vercel: 100GB bandwidth/month
- Anthropic: $5 credit (~50-200 analyses)

**Production:**
- Vercel Pro: $20/month
- Anthropic: ~$0.01-0.05 per analysis
- **Total:** $25-45/month (500 analyses)

---

## 📁 FILES

- `api/analyze.js` - Main API (Claude integration)
- `package.json` - Dependencies
- `vercel.json` - Config + CORS
- `DEPLOY-GUIDE.md` - Full deployment guide
- `TESTING-GUIDE.md` - Testing procedures

---

## 🔒 SECURITY

**API Key Storage:**
- Stored in Vercel environment variables
- Never exposed to frontend
- Encrypted at rest

**CORS:**
- Currently allows all origins (`*`)
- For production, change to: `https://dudediligence.pro`
- Edit in `vercel.json`

---

## ✅ SUCCESS CHECKLIST

- [ ] Vercel CLI installed
- [ ] Anthropic API key obtained
- [ ] Backend deployed (`vercel`)
- [ ] API key added (`vercel env add`)
- [ ] Redeployed (`vercel --prod`)
- [ ] Custom domain configured
- [ ] DNS records added
- [ ] curl test passes
- [ ] Website test passes
- [ ] Extraction accuracy > 85%
- [ ] No errors in logs

**If ALL checked → LIVE!** 🚀

---

## 📞 SUPPORT

**Vercel:** https://vercel.com/docs  
**Anthropic:** https://docs.anthropic.com  
**Logs:** `vercel logs --follow`

---

## 🎯 NEXT STEPS

1. ✅ Deploy backend (this guide)
2. ✅ Setup Formspree (main project docs)
3. ✅ Upload frontend to GitHub
4. ✅ Test end-to-end
5. 🚀 **LAUNCH!**

---

**Created:** December 8, 2025  
**Status:** READY ✅  
**Time:** 15 minutes  

**YOU GOT THIS!** 💪
