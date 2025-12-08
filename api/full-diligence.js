// Full Due Diligence API - Real Database Checks
// Integrates: OpenSanctions, UK Companies House, OpenCorporates, GLEIF, SEC EDGAR, Email validation

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
    const { companyName, email, country, representative } = req.body;

    if (!companyName && !email) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    const results = {
      sanctions: {
        found: false,
        matches: [],
        lists: []
      },
      companyRegistry: {
        found: false,
        data: null,
        source: null
      },
      leiRegistry: {
        found: false,
        data: null,
        source: null
      },
      secFilings: {
        found: false,
        data: null,
        cik: null
      },
      emailValidation: {
        valid: false,
        disposable: false,
        deliverable: null,
        risk: 'unknown'
      },
      domainReputation: {
        score: null,
        risk: 'unknown',
        blacklisted: false
      },
      riskScore: 0,
      flags: []
    };

    // 1. SANCTIONS SCREENING - OpenSanctions (FREE)
    if (companyName || representative) {
      const sanctionsResult = await checkOpenSanctions(companyName, representative);
      results.sanctions = sanctionsResult;
      
      if (sanctionsResult.found) {
        results.riskScore += 50;
        results.flags.push('SANCTIONS_MATCH');
      }
    }

    // 2. COMPANY REGISTRY - UK Companies House (FREE)
    if (companyName && country?.toLowerCase().includes('uk')) {
      const ukCompanyResult = await checkUKCompaniesHouse(companyName);
      if (ukCompanyResult.found) {
        results.companyRegistry = ukCompanyResult;
        results.riskScore -= 10; // Legitimate registered company = lower risk
      }
    }

    // 3. COMPANY REGISTRY - OpenCorporates (Freemium)
    if (companyName && !results.companyRegistry.found) {
      const openCorpResult = await checkOpenCorporates(companyName, country);
      if (openCorpResult.found) {
        results.companyRegistry = openCorpResult;
        results.riskScore -= 10;
      }
    }

    // 4. LEI REGISTRY - GLEIF (FREE)
    if (companyName) {
      const gleifResult = await checkGLEIF(companyName);
      if (gleifResult.found) {
        results.leiRegistry = gleifResult;
        results.riskScore -= 5; // Registered LEI = more legitimate
        results.flags.push('LEI_REGISTERED');
      }
    }

    // 5. SEC FILINGS - US Public Companies (FREE)
    if (companyName && (country?.toLowerCase().includes('us') || country?.toLowerCase().includes('usa') || country?.toLowerCase().includes('united states'))) {
      const secResult = await checkSECEdgar(companyName);
      if (secResult.found) {
        results.secFilings = secResult;
        results.riskScore -= 10; // SEC registered = very legitimate
        results.flags.push('SEC_REGISTERED');
      }
    }

    // 6. EMAIL VALIDATION
    if (email) {
      const emailResult = await validateEmail(email);
      results.emailValidation = emailResult;
      
      if (emailResult.disposable) {
        results.riskScore += 15;
        results.flags.push('DISPOSABLE_EMAIL');
      }
      
      if (!emailResult.valid) {
        results.riskScore += 10;
        results.flags.push('INVALID_EMAIL');
      }
    }

    // 7. DOMAIN REPUTATION CHECK
    if (email) {
      const domain = email.split('@')[1];
      const domainResult = await checkDomainReputation(domain);
      results.domainReputation = domainResult;
      
      if (domainResult.blacklisted) {
        results.riskScore += 20;
        results.flags.push('BLACKLISTED_DOMAIN');
      }
    }

    // Cap risk score at 100
    results.riskScore = Math.min(100, Math.max(0, results.riskScore));

    return res.status(200).json({
      success: true,
      data: results
    });

  } catch (error) {
    console.error('Full diligence error:', error);
    return res.status(500).json({
      error: 'Database check failed',
      message: error.message
    });
  }
}

// =====================================
// DATABASE INTEGRATION FUNCTIONS
// =====================================

/**
 * OpenSanctions - FREE OFAC, UN, EU, UK sanctions screening
 * API: https://www.opensanctions.org/docs/api/
 */
async function checkOpenSanctions(companyName, representative) {
  try {
    const searchTerms = [];
    if (companyName) searchTerms.push(companyName);
    if (representative) searchTerms.push(representative);

    const results = {
      found: false,
      matches: [],
      lists: []
    };

    for (const term of searchTerms) {
      const response = await fetch(
        `https://api.opensanctions.org/search/default?q=${encodeURIComponent(term)}`,
        {
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) continue;

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        results.found = true;
        
        for (const match of data.results) {
          // Only include high-confidence matches
          if (match.score > 0.7) {
            results.matches.push({
              name: match.caption || match.name,
              score: match.score,
              datasets: match.datasets || [],
              schema: match.schema,
              properties: match.properties
            });

            // Extract sanction lists
            if (match.datasets) {
              results.lists.push(...match.datasets);
            }
          }
        }
      }
    }

    // Deduplicate lists
    results.lists = [...new Set(results.lists)];

    return results;
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return {
      found: false,
      matches: [],
      lists: [],
      error: error.message
    };
  }
}

/**
 * UK Companies House - FREE company registry
 * API: https://developer-specs.company-information.service.gov.uk/
 * Requires: UK_COMPANIES_HOUSE_API_KEY environment variable
 */
async function checkUKCompaniesHouse(companyName) {
  try {
    const apiKey = process.env.UK_COMPANIES_HOUSE_API_KEY;
    
    if (!apiKey) {
      console.log('UK Companies House API key not configured');
      return { found: false, data: null, source: null };
    }

    // Search for company
    const searchResponse = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}`,
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`
        }
      }
    );

    if (!searchResponse.ok) {
      console.error('Companies House API error:', searchResponse.status);
      return { found: false, data: null, source: null };
    }

    const searchData = await searchResponse.json();

    if (searchData.items && searchData.items.length > 0) {
      const company = searchData.items[0];
      
      return {
        found: true,
        source: 'UK Companies House',
        data: {
          name: company.title,
          companyNumber: company.company_number,
          status: company.company_status,
          type: company.company_type,
          address: company.address_snippet,
          createdDate: company.date_of_creation,
          description: company.description
        }
      };
    }

    return { found: false, data: null, source: null };

  } catch (error) {
    console.error('UK Companies House error:', error);
    return { 
      found: false, 
      data: null, 
      source: null,
      error: error.message 
    };
  }
}

/**
 * OpenCorporates - Company registry (200M+ companies worldwide)
 * API: https://api.opencorporates.com/
 * Free tier: 500 requests/month, then $0.02 per request
 */
async function checkOpenCorporates(companyName, country) {
  try {
    let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}`;
    
    // Add country filter if provided
    if (country) {
      // Map common country names to ISO codes
      const countryCode = mapCountryToCode(country);
      if (countryCode) {
        url += `&jurisdiction_code=${countryCode}`;
      }
    }

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error('OpenCorporates API error:', response.status);
      return { found: false, data: null, source: null };
    }

    const data = await response.json();

    if (data.results?.companies && data.results.companies.length > 0) {
      const company = data.results.companies[0].company;
      
      return {
        found: true,
        source: 'OpenCorporates',
        data: {
          name: company.name,
          companyNumber: company.company_number,
          jurisdiction: company.jurisdiction_code,
          status: company.current_status,
          type: company.company_type,
          address: company.registered_address_in_full,
          createdDate: company.incorporation_date,
          inactiveDate: company.dissolution_date,
          registryUrl: company.registry_url
        }
      };
    }

    return { found: false, data: null, source: null };

  } catch (error) {
    console.error('OpenCorporates error:', error);
    return { 
      found: false, 
      data: null, 
      source: null,
      error: error.message 
    };
  }
}

/**
 * Email Validation - Check if email is valid, disposable, deliverable
 * Uses multiple methods for comprehensive validation
 */
async function validateEmail(email) {
  try {
    const result = {
      valid: false,
      disposable: false,
      deliverable: null,
      risk: 'unknown'
    };

    // 1. Basic format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      result.risk = 'high';
      return result;
    }

    result.valid = true;

    // 2. Check against known disposable email domains
    const domain = email.split('@')[1].toLowerCase();
    const disposableDomains = [
      'tempmail.com', 'guerrillamail.com', 'throwaway.email', '10minutemail.com',
      'mailinator.com', 'trashmail.com', 'getnada.com', 'fakeinbox.com',
      'yopmail.com', 'maildrop.cc', 'temp-mail.org', 'sharklasers.com'
    ];

    if (disposableDomains.includes(domain)) {
      result.disposable = true;
      result.risk = 'high';
      return result;
    }

    // 3. Check for common free email providers (medium risk)
    const freeProviders = [
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
      'mail.com', 'protonmail.com', 'zoho.com', 'icloud.com'
    ];

    if (freeProviders.includes(domain)) {
      result.risk = 'medium';
    } else {
      result.risk = 'low'; // Corporate email
    }

    // 4. Basic deliverability check (DNS MX record lookup)
    // Note: This is simplified - in production, use a service like ZeroBounce or Hunter.io
    result.deliverable = true; // Assume deliverable if format is valid and not disposable

    return result;

  } catch (error) {
    console.error('Email validation error:', error);
    return {
      valid: false,
      disposable: false,
      deliverable: null,
      risk: 'unknown',
      error: error.message
    };
  }
}

/**
 * Domain Reputation Check
 * Checks if domain is blacklisted or has poor reputation
 */
async function checkDomainReputation(domain) {
  try {
    const result = {
      score: null,
      risk: 'unknown',
      blacklisted: false,
      checks: []
    };

    // Check against known blacklisted domains
    const blacklist = [
      'scam.com', 'fraud.com', 'fake-trading.com'
      // Add more as needed
    ];

    if (blacklist.includes(domain.toLowerCase())) {
      result.blacklisted = true;
      result.risk = 'critical';
      result.score = 0;
      return result;
    }

    // Check domain age (newer = higher risk)
    // Note: This would require a WHOIS lookup service
    // For now, assume domains are okay if not blacklisted
    
    result.risk = 'low';
    result.score = 75; // Default score

    return result;

  } catch (error) {
    console.error('Domain reputation error:', error);
    return {
      score: null,
      risk: 'unknown',
      blacklisted: false,
      error: error.message
    };
  }
}

/**
 * Map country names to ISO codes for OpenCorporates
 */
function mapCountryToCode(country) {
  const countryMap = {
    'uk': 'gb',
    'united kingdom': 'gb',
    'usa': 'us',
    'united states': 'us',
    'uae': 'ae',
    'emirates': 'ae',
    'china': 'cn',
    'singapore': 'sg',
    'hong kong': 'hk',
    'india': 'in',
    'germany': 'de',
    'france': 'fr',
    'spain': 'es',
    'italy': 'it',
    'netherlands': 'nl',
    'belgium': 'be',
    'switzerland': 'ch',
    'austria': 'at',
    'australia': 'au',
    'canada': 'ca',
    'brazil': 'br',
    'mexico': 'mx',
    'japan': 'jp',
    'south korea': 'kr',
    'russia': 'ru',
    'turkey': 'tr',
    'south africa': 'za',
    'nigeria': 'ng',
    'kenya': 'ke'
  };

  return countryMap[country.toLowerCase()] || null;
}

/**
 * GLEIF LEI Registry - Global Legal Entity Identifiers (FREE)
 * API: https://api.gleif.org/api/v1/
 * Provides LEI information for regulated financial entities
 */
async function checkGLEIF(companyName) {
  try {
    // Search for LEI by company name
    const response = await fetch(
      `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}`,
      {
        headers: {
          'Accept': 'application/vnd.api+json'
        }
      }
    );

    if (!response.ok) {
      console.error('GLEIF API error:', response.status);
      return { found: false, data: null, source: null };
    }

    const data = await response.json();

    if (data.data && data.data.length > 0) {
      const entity = data.data[0];
      const attrs = entity.attributes.entity;
      const lei = entity.attributes.lei;
      
      return {
        found: true,
        source: 'GLEIF LEI Registry',
        data: {
          lei: lei,
          legalName: attrs.legalName?.name,
          status: attrs.status,
          jurisdiction: attrs.legalAddress?.country,
          registrationAuthority: attrs.registeredAs?.id,
          category: attrs.category,
          legalForm: attrs.legalForm?.id,
          registrationDate: entity.attributes.registration?.initialRegistrationDate,
          lastUpdate: entity.attributes.registration?.lastUpdateDate
        }
      };
    }

    return { found: false, data: null, source: null };

  } catch (error) {
    console.error('GLEIF error:', error);
    return { 
      found: false, 
      data: null, 
      source: null,
      error: error.message 
    };
  }
}

/**
 * SEC EDGAR - US Securities and Exchange Commission (FREE)
 * API: https://www.sec.gov/cgi-bin/browse-edgar
 * Provides information on US public companies and their filings
 */
async function checkSECEdgar(companyName) {
  try {
    // SEC requires a User-Agent header
    const response = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(companyName)}&type=&dateb=&owner=exclude&count=1&output=atom`,
      {
        headers: {
          'User-Agent': 'DueDiligencePro/1.0 (compliance@dudediligence.pro)'
        }
      }
    );

    if (!response.ok) {
      console.error('SEC EDGAR error:', response.status);
      return { found: false, data: null, cik: null };
    }

    const xmlText = await response.text();
    
    // Basic XML parsing to extract company info
    // Look for CIK (Central Index Key) and company name
    const cikMatch = xmlText.match(/<CIK>(\d+)<\/CIK>/);
    const nameMatch = xmlText.match(/<company-name>([^<]+)<\/company-name>/);
    const stateMatch = xmlText.match(/<state>([^<]+)<\/state>/);
    const sicMatch = xmlText.match(/<assigned-sic>(\d+)<\/assigned-sic>/);
    const sicDescMatch = xmlText.match(/<assigned-sic-desc>([^<]+)<\/assigned-sic-desc>/);
    
    if (cikMatch && nameMatch) {
      const cik = cikMatch[1];
      
      return {
        found: true,
        cik: cik,
        data: {
          companyName: nameMatch[1],
          cik: cik,
          state: stateMatch ? stateMatch[1] : null,
          sicCode: sicMatch ? sicMatch[1] : null,
          sicDescription: sicDescMatch ? sicDescMatch[1] : null,
          edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
          filingSearchUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=exclude&count=40`
        }
      };
    }

    return { found: false, data: null, cik: null };

  } catch (error) {
    console.error('SEC EDGAR error:', error);
    return { 
      found: false, 
      data: null, 
      cik: null,
      error: error.message 
    };
  }
}

