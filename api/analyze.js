import Anthropic from "@anthropic-ai/sdk";
import pdfParse from "pdf-parse";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

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

    // Call Claude API with ENHANCED extraction prompt
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `You are a commodity trading document analyst. Extract structured data from this document.

CRITICAL EXTRACTION RULES:
1. **Bank Name**: Extract ONLY the actual bank name (e.g., "Emirates NBD", "HSBC", "Citibank"). 
   - DO NOT extract payment instruments (SBLC, LC, MT103, MT760, BG, DLC)
   - DO NOT extract payment terms
   - If no actual bank name is found, return "Not specified"

2. **Source of Funds**: This is WHERE THE MONEY COMES FROM (e.g., "Trading revenue", "Company capital", "Loan facility", "Previous shipments").
   - DO NOT extract Incoterms (FOB, CIF, CFR, DDP, etc.)
   - DO NOT extract payment instruments (LC, SBLC, etc.)
   - If unclear, return "Not specified"

3. **Payment Terms**: Extract payment method and instruments (LC, SBLC, MT103, BG, etc.) separately from bank name

4. **Representative Name**: Extract the person's full name who is signing or representing the company
   - Look for "Authorized Signatory:", "Representative:", "I, [NAME]", signatures
   - DO NOT return generic terms like "Authorized Representative"

5. **Email**: Corporate emails preferred over free emails (gmail, yahoo, hotmail)

Document text:
${text}

Return ONLY valid JSON (no markdown, no explanation):
{
  "documentType": "LOI/ICPO/KYC/SCO",
  "commodity": "specific commodity name",
  "quantity": "amount with unit",
  "price": "price per unit",
  "buyer": {
    "name": "company name",
    "country": "country name",
    "representative": "full person name or Not specified",
    "email": "email or Not specified"
  },
  "seller": {
    "name": "company name or Not specified",
    "country": "country name or Not specified",
    "representative": "full person name or Not specified",
    "email": "email or Not specified"
  },
  "paymentTerms": "ONLY payment instruments and methods (LC at sight, SBLC, MT103, etc.)",
  "bankName": "ONLY actual bank name, NOT payment instruments",
  "sourceOfFunds": "WHERE money comes from, NOT Incoterms or payment terms",
  "deliveryTerms": "FOB, CIF, CFR, etc. and delivery location",
  "port": "loading/discharge port"
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
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        details: parseError.message 
      });
    }

    return res.status(200).json({
      success: true,
      data: extractedData
    });

  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ 
      error: 'Analysis failed',
      details: error.message 
    });
  }
}
