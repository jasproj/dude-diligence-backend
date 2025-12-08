# ⚡ QUICK TESTING GUIDE - VERIFY YOUR BACKEND WORKS

**After deploying, use these tests to verify everything works!**

---

## 🧪 TEST 1: Backend Health Check (1 min)

### **Test the API endpoint is live:**

```bash
curl https://api.dudediligence.pro/api/analyze
```

**Expected response:**
```json
{"error":"Method not allowed"}
```

**✅ This is GOOD!** It means:
- API is live
- Endpoint exists  
- It's rejecting GET requests (correct - should only accept POST)

**❌ If you see:** Connection error, timeout, or "not found"
- **Problem:** Backend not deployed OR DNS not configured
- **Fix:** Check Vercel dashboard, verify deployment, check DNS records

---

## 🧪 TEST 2: Simple Text Analysis (2 mins)

### **Test AI extraction with simple text:**

```bash
curl -X POST https://api.dudediligence.pro/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "test-loi.txt",
    "fileType": "text/plain",
    "fileData": "VGhpcyBpcyBhIGxldHRlciBvZiBpbnRlbnQgZnJvbSBBQkMgQ29ycCB0byBYWVogTHRkIGZvciAxMCwwMDAgTVQgb2Ygc3VnYXIgYXQgJDUwMCBwZXIgTVQu"
  }'
```

*(The base64 decodes to: "This is a letter of intent from ABC Corp to XYZ Ltd for 10,000 MT of sugar at $500 per MT.")*

**Expected response:**
```json
{
  "success": true,
  "data": {
    "documentType": "LOI",
    "commodity": "sugar",
    "quantity": "10,000 MT",
    "price": "$500 per MT",
    "buyer": {
      "name": "ABC Corp",
      ...
    },
    "seller": {
      "name": "XYZ Ltd",
      ...
    }
  }
}
```

**✅ If you see this:**
- AI extraction is working!
- Claude API key is configured
- Backend is functional

**❌ If you see error:**
- "ANTHROPIC_API_KEY is not defined" → Add env variable: `vercel env add ANTHROPIC_API_KEY`
- "Invalid API key" → Check your Anthropic key is correct
- "Rate limit" → Wait a minute and try again
- Other error → Check Vercel logs: `vercel logs`

---

## 🧪 TEST 3: PDF Upload (3 mins)

### **Test with real PDF from your website:**

1. Open: https://dudediligence.pro
2. Press F12 (open console)
3. Upload ANY PDF document (LOI, ICPO, KYC, anything)
4. Click "Run The Dude"
5. Watch the console for API call

**What to look for in Console:**

**✅ GOOD:**
```
POST https://api.dudediligence.pro/api/analyze
Status: 200
Response: {success: true, data: {...}}
```

**❌ BAD:**
```
POST https://api.dudediligence.pro/api/analyze
Status: 500 (or 404, 403, etc.)
```

**Check Network Tab (F12 → Network):**
- Click the `/analyze` request
- Click "Response" tab
- See what error message backend returned
- Common issues:
  - 500: Backend error (check Vercel logs)
  - 404: API endpoint not found (check deployment)
  - 403: CORS issue (check vercel.json has CORS headers)

---

## 🧪 TEST 4: End-to-End Flow (5 mins)

### **Complete user journey:**

1. **Upload document** → File uploads successfully
2. **Click "Run The Dude"** → Shows "Analyzing..." animation
3. **Review form appears** → AI extracted data shows (not empty/demo)
4. **Check extracted data quality:**
   - Company names look real?
   - Email addresses extracted?
   - Commodity/quantity detected?
   - NOT showing: "Demo Corp" or "Unknown" for everything
5. **Click "Continue with AI Analysis"** → Risk score calculated
6. **Click "Generate Report"** → Risk report shows
7. **Click "Export PDF"** → Email gate modal appears
8. **Enter test email** → Formspree notification received
9. **PDF downloads** → 5-page professional report

**✅ If ALL steps work:**
- **YOU'RE FULLY OPERATIONAL!** 🎉
- Ready for beta testers
- Backend + Frontend + Lead capture all working

**❌ If any step fails:**
- Check that specific section
- See troubleshooting below

---

## 🔧 TROUBLESHOOTING GUIDE

### **Issue: "No data extracted" or everything shows "Not specified"**

**Possible causes:**
1. **PDF has no text** (scanned image, not searchable)
   - Solution: Test with a different PDF that has selectable text
   
2. **Document format unexpected**
   - Solution: Check `rawText` in API response (first 500 chars)
   - Verify text was extracted from PDF
   
3. **Claude API struggling with format**
   - Solution: Improve prompt in `api/analyze.js`
   - Add more examples to prompt

### **Issue: Extraction quality is poor (< 70% accurate)**

**Improvements to make:**

1. **Add document-specific examples in prompt**
   ```javascript
   // In api/analyze.js, add to prompt:
   Here are examples of good extractions:
   - Buyer: "ABC Trading LLC" (not "ABC" or "Trading")
   - Email: "john@company.com" (not "john" or "company.com")
   ```

2. **Add validation layer**
   ```javascript
   // After Claude extraction, validate:
   if (!extracted.buyer.email.includes('@')) {
     // Try to find email again
   }
   ```

3. **Use Claude Opus for better accuracy** (more expensive but better)
   ```javascript
   // Change in api/analyze.js:
   model: 'claude-opus-4-20250514', // Was: claude-sonnet-4-20250514
   ```

### **Issue: Slow performance (> 10 seconds)**

**Optimizations:**

1. **Reduce max_tokens**
   ```javascript
   // In api/analyze.js:
   max_tokens: 1500, // Was: 2000
   ```

2. **Add timeout**
   ```javascript
   // In frontend, add timeout:
   const controller = new AbortController();
   setTimeout(() => controller.abort(), 15000); // 15 sec timeout
   
   fetch('...', {
     signal: controller.signal,
     ...
   })
   ```

3. **Cache common results** (advanced)
   - Store document hash → extraction mapping
   - Return cached result if same doc uploaded again

---

## 📊 PERFORMANCE BENCHMARKS

**Expected performance:**

| Metric | Target | Actual |
|--------|--------|--------|
| Response time | < 10 sec | Test and note: _____ |
| Extraction accuracy | > 85% | Test and note: _____ |
| PDF parsing success | > 95% | Test and note: _____ |
| Uptime | > 99% | Check after 1 week |

**How to test accuracy:**

1. Upload 10 real documents (LOIs, ICPOs, KYCs)
2. For each, check:
   - Buyer name extracted correctly? (Y/N)
   - Seller name extracted correctly? (Y/N)
   - Email extracted correctly? (Y/N)
   - Commodity extracted correctly? (Y/N)
   - Quantity extracted correctly? (Y/N)
3. Calculate: (Correct fields / Total fields) × 100

**Target: > 85% accuracy**

If below 85% → Improve prompts in `api/analyze.js`

---

## ✅ SUCCESS CRITERIA

Your backend is ready for beta when:

- [ ] Health check passes (curl test works)
- [ ] Text analysis works (simple curl test)
- [ ] PDF upload works (website test)
- [ ] Extraction accuracy > 85%
- [ ] Response time < 10 seconds
- [ ] No CORS errors in console
- [ ] Lead capture working (Formspree email received)
- [ ] PDF download works (5 pages, professional)
- [ ] Tested with 5+ different documents
- [ ] All document types work (LOI, ICPO, KYC)

**If ALL checked → LAUNCH!** 🚀

---

## 📞 GETTING HELP

**Check logs first:**
```bash
vercel logs --follow
```

Watch real-time as you test. Errors will show immediately.

**Common log messages:**

✅ `"POST /api/analyze 200"` → Working perfectly
❌ `"Error: ANTHROPIC_API_KEY is not defined"` → Add env variable
❌ `"Error: Invalid API key"` → Check Anthropic key
❌ `"Error: JSON parse error"` → Claude returned bad JSON (improve prompt)

**Still stuck?**
1. Check Vercel status: https://vercel-status.com
2. Check Anthropic status: https://status.anthropic.com
3. Re-read DEPLOY-GUIDE.md
4. Start fresh Claude chat with error details

---

**Created:** December 8, 2025  
**Purpose:** Verify backend deployment  
**Time Required:** 10-15 minutes total  

**GOOD LUCK!** 🎯
