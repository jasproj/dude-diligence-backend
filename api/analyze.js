// api/analyze.js - Updated to support DOCX files
// Add extractedText handling for Word documents

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
        const { fileData, fileName, fileType, extractedText } = req.body;

        if (!fileData && !extractedText) {
            return res.status(400).json({ success: false, error: 'No file data or extracted text provided' });
        }

        // Use Anthropic API to analyze the document
        const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
        
        if (!ANTHROPIC_API_KEY) {
            return res.status(500).json({ success: false, error: 'API key not configured' });
        }

        let contentToAnalyze;
        
        // If DOCX extracted text is provided, use that directly
        if (extractedText) {
            console.log('Using pre-extracted text from DOCX, length:', extractedText.length);
            contentToAnalyze = [
                {
                    type: "text",
                    text: `Analyze this document text extracted from a Word file (${fileName}):\n\n${extractedText}`
                }
            ];
        } else {
            // For PDFs and images, send as base64
            const mediaType = fileType === 'application/pdf' ? 'application/pdf' : 
                             fileType.startsWith('image/') ? fileType : 'application/pdf';
            
            contentToAnalyze = [
                {
                    type: "document",
                    source: {
                        type: "base64",
                        media_type: mediaType,
                        data: fileData
                    }
                },
                {
                    type: "text",
                    text: "Analyze this document."
                }
            ];
        }

        const systemPrompt = `You are a due diligence document analyzer for commodity trading. Extract key information from business documents.

Return a JSON object with these fields (use null if not found):
{
    "documentType": "FCO|LOI|ICPO|SCO|KYC|CONTRACT|OTHER",
    "buyer": {
        "name": "company name",
        "representative": "person name",
        "email": "email@example.com",
        "phone": "phone number",
        "country": "country name",
        "address": "full address"
    },
    "seller": {
        "name": "company name",
        "representative": "person name", 
        "email": "email@example.com",
        "phone": "phone number",
        "country": "country name",
        "address": "full address"
    },
    "commodity": "product being traded",
    "quantity": "amount with units",
    "price": "price with currency",
    "paymentTerms": "LC, TT, etc",
    "deliveryTerms": "FOB, CIF, etc",
    "port": "port name",
    "bankName": "bank name if mentioned",
    "iban": "IBAN if mentioned",
    "swift": "SWIFT/BIC if mentioned"
}

Extract ALL parties mentioned (buyers, sellers, agents, banks, etc). Be thorough.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: systemPrompt,
                messages: [
                    {
                        role: 'user',
                        content: contentToAnalyze
                    }
                ]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Anthropic API error:', errorText);
            return res.status(500).json({ success: false, error: 'AI analysis failed' });
        }

        const aiResponse = await response.json();
        const aiText = aiResponse.content[0].text;

        // Parse the JSON from AI response
        let extractedData;
        try {
            // Find JSON in the response
            const jsonMatch = aiText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                extractedData = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in response');
            }
        } catch (parseError) {
            console.error('JSON parse error:', parseError);
            extractedData = { raw: aiText };
        }

        return res.status(200).json({
            success: true,
            data: extractedData,
            fileName: fileName
        });

    } catch (error) {
        console.error('Analysis error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
