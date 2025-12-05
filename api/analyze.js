import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  // AGGRESSIVE CORS HEADERS - SET FIRST BEFORE ANYTHING ELSE
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fileData, fileName, fileType } = req.body;

    if (!fileData) {
      return res.status(400).json({ error: 'No file data provided' });
    }

    // Convert base64 to buffer
    const buffer = Buffer.from(fileData, 'base64');

    // Parse PDF
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract text from PDF' });
    }

    // Call Claude API with ULTIMATE extraction prompt
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `You are an expert commodity trading document analyst. Extract ALL data with forensic precision.

CRITICAL EXTRACTION RULES:

1. **PARTIES - Extract EVERY entity mentioned:**
   - Buyer (company purchasing)
   - Seller (company supplying)
   - Intermediary/Broker (facilitators, "Via:", agents)
   - Other parties (banks, inspection agencies if named as entities)
   - For EACH party extract:
     * Full legal company name
     * Role (Buyer/Seller/Intermediary/Broker/Other)
     * Country
     * Full address if available
     * Business registration number / Tax ID
     * Representative name (actual person)
     * Representative passport number if listed
     * Email address
     * Phone number
     * WhatsApp number if different from phone

2. **BANKING - Extract ALL banking information:**
   - For EACH party (buyer and seller), extract:
     * Bank name (actual institution name)
     * Bank address
     * Account holder name
     * Account number
     * SWIFT/BIC code
     * IBAN if listed
     * Bank contact phone/email
   - CRITICAL: Do NOT confuse payment instruments (SBLC, LC, MT103) with bank names

3. **PAYMENT TERMS:**
   - Payment method: LC, SBLC, DLC, TT, MT103, etc.
   - Payment timing: At sight, 30 days, 60 days, etc.
   - Payment location: Loading port, discharge port, etc.
   - Payment percentage splits if applicable
   - Performance bonds or guarantees

4. **SOURCE OF FUNDS:**
   - WHERE money comes from: Trading revenue, Company capital, Loan, etc.
   - NEVER extract Incoterms (FOB, CIF, CFR) as source of funds
   - NEVER extract payment instruments as source of funds
   - If not mentioned, return "Not specified"

5. **COMMODITY DETAILS:**
   - Exact product name and grade
   - Origin country
   - Quantity (total and monthly if applicable)
   - Price per unit with currency
   - Total contract value
   - Quality specifications (ICUMSA rating, etc.)
   - Packaging details

6. **DELIVERY & LOGISTICS:**
   - Incoterms (FOB, CIF, CFR, DDP, etc.)
   - Loading port with country
   - Discharge port with country
   - Delivery timeline
   - Inspection agency (SGS, Bureau Veritas, etc.)
   - Insurance percentage

7. **DOCUMENT METADATA:**
   - Document type (LOI, ICPO, FCO, SPA, etc.)
   - Date of issuance
   - Reference number
   - Expiry date if applicable

8. **REPRESENTATIVE DETAILS:**
   - Extract actual person names from signatures
   - Look for: "Legal Representative:", "Authorized Signatory:", titles (CEO, Managing Director)
   - DO NOT use generic terms like "Authorized Representative"
   - Extract passport numbers if listed
   - Extract nationality if listed

Document text:
${text}

Return ONLY valid JSON (no markdown, no explanation, no preamble):
{
  "documentType": "LOI/ICPO/FCO/SPA/KYC/SCO",
  "referenceNumber": "reference if found",
  "dateIssued": "date if found",
  "expiryDate": "expiry if found",
  "commodity": {
    "name": "exact product name",
    "grade": "grade/specification",
    "origin": "country of origin",
    "quantity": "total quantity with unit",
    "monthlyQuantity": "if applicable",
    "pricePerUnit": "price with currency",
    "totalValue": "total contract value",
    "specifications": "key specs like ICUMSA rating",
    "packaging": "packaging details"
  },
  "parties": [
    {
      "role": "Buyer or Seller or Intermediary or Broker or Other",
      "companyName": "full legal name",
      "address": "full address if available",
      "country": "country",
      "businessRegistration": "registration number or tax ID",
      "representative": {
        "name": "full person name",
        "title": "CEO, Managing Director, etc.",
        "passportNumber": "if listed",
        "nationality": "if listed"
      },
      "contact": {
        "email": "email address",
        "phone": "phone number",
        "whatsapp": "whatsapp if different"
      },
      "banking": {
        "bankName": "actual bank name",
        "bankAddress": "bank address",
        "accountHolder": "account holder name",
        "accountNumber": "account number",
        "swiftCode": "SWIFT/BIC code",
        "iban": "IBAN if listed"
      }
    }
  ],
  "buyer": {
    "name": "primary buyer company",
    "country": "country",
    "representative": "person name",
    "email": "email or Not specified"
  },
  "seller": {
    "name": "primary seller company",
    "country": "country",
    "representative": "person name",
    "email": "email or Not specified"
  },
  "paymentTerms": {
    "method": "LC at sight, SBLC, DLC, TT, MT103, etc.",
    "timing": "at sight, 30 days, etc.",
    "location": "loading port, discharge port, etc.",
    "performanceBond": "if applicable",
    "details": "full payment terms description"
  },
  "bankName": "primary bank name (NOT payment instrument)",
  "sourceOfFunds": "WHERE money comes from (NOT Incoterms or payment methods)",
  "delivery": {
    "incoterms": "FOB, CIF, CFR, DDP, etc.",
    "loadingPort": "port and country",
    "dischargePort": "port and country",
    "timeline": "delivery timeframe",
    "inspection": "SGS, Bureau Veritas, etc.",
    "insurance": "insurance percentage if listed"
  },
  "port": "loading and discharge ports summary"
}`
        }
      ]
    });

    // Parse Claude's response
    let extractedData;
    try {
      const content = message.content[0].text;
      // Remove markdown code blocks if present
      const jsonText = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      extractedData = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Raw response:', message.content[0].text);
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        details: parseError.message,
        rawResponse: message.content[0].text.substring(0, 500)
      });
    }

    // Return success with CORS headers already set
    return res.status(200).json({
      success: true,
      data: extractedData
    });

  } catch (error) {
    console.error('Analysis error:', error);
    
    // Handle Anthropic API errors specifically
    if (error.status === 401) {
      return res.status(500).json({ 
        error: 'API authentication failed',
        details: 'Invalid or missing API key'
      });
    }
    
    if (error.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        details: 'Too many requests. Please try again later.'
      });
    }
    
    return res.status(500).json({ 
      error: 'Analysis failed',
      details: error.message 
    });
  }
}
