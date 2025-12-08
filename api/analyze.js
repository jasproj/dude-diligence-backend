import Anthropic from '@anthropic-ai/sdk';
import pdf from 'pdf-parse/lib/pdf-parse.js';

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fileData, fileName, fileType } = req.body;

    if (!fileData || !fileName) {
      return res.status(400).json({ error: 'Missing file data or name' });
    }

    let documentText = '';

    // Extract text based on file type
    if (fileType === 'text/plain') {
      // Decode base64 text file
      const buffer = Buffer.from(fileData, 'base64');
      documentText = buffer.toString('utf-8');
    } else if (fileType === 'application/pdf') {
      // Parse PDF
      const buffer = Buffer.from(fileData, 'base64');
      const pdfData = await pdf(buffer);
      documentText = pdfData.text;
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Detect document type
    const textLower = documentText.toLowerCase();
    let documentType = 'Unknown';
    if (textLower.includes('kyc') || textLower.includes('compliance package') || textLower.includes('affidavit')) {
      documentType = 'KYC';
    } else if (textLower.includes('letter of intent') || textLower.includes('loi')) {
      documentType = 'LOI';
    } else if (textLower.includes('icpo') || textLower.includes('purchase order')) {
      documentType = 'ICPO';
    }

    // Create appropriate prompt based on document type
    let prompt = '';
    
    if (documentType === 'KYC') {
      prompt = `Extract KYC/compliance information from this document:

${documentText}

Return ONLY valid JSON with this exact structure (no other text):

{
  "documentType": "KYC",
  "company": {
    "name": "company name or Not specified",
    "country": "country or Not specified",
    "address": "address or Not specified"
  },
  "representative": {
    "name": "person name or Not specified",
    "passport": "passport number or Not specified",
    "email": "email or Not specified"
  },
  "banking": {
    "bankName": "bank name or Not specified",
    "accountNumber": "account number or Not specified",
    "swift": "swift code or Not specified"
  },
  "sourceOfFunds": "description or Not specified"
}`;
    } else {
      prompt = `Extract commodity trading information from this document (${fileName}):

${documentText}

Return ONLY valid JSON with this exact structure (no other text):

{
  "documentType": "LOI/ICPO/SCO/Other",
  "commodity": "commodity name or Not specified",
  "quantity": "quantity with units or Not specified",
  "price": "price per unit or Not specified",
  "buyer": {
    "name": "company name or Not specified",
    "country": "country or Not specified",
    "representative": "name or Not specified",
    "email": "email or Not specified"
  },
  "seller": {
    "name": "company name or Not specified",
    "country": "country or Not specified",
    "representative": "name or Not specified",
    "email": "email or Not specified"
  },
  "paymentTerms": "terms or Not specified",
  "deliveryTerms": "FOB/CIF/etc or Not specified",
  "port": "port name or Not specified"
}`;
    }

    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    // Parse Claude's response
    let responseText = message.content[0].text;
    
    // Clean up any markdown code blocks
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const extractedData = JSON.parse(responseText);

    // Return the extracted data
    return res.status(200).json({
      success: true,
      data: extractedData,
      rawText: documentText.substring(0, 500) // First 500 chars for debugging
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'Analysis failed',
      message: error.message
    });
  }
}
