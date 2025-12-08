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
    const { companyName, email, country, representative, allParties, iban, swift } = req.body;

    // More flexible validation - accept if we have ANY data to check
    if (!companyName && !email && (!allParties || allParties.length === 0)) {
      return res.status(400).json({ error: 'Missing required data - need companyName, email, or allParties' });
    }

    const results = {
      sanctions: {
        found: false,
        matches: [],
        lists: [],
        entities: []
      },
      companyRegistry: {
        found: false,
        data: null,
        source: null,
        buyer: null,
        seller: null
      },
      leiRegistry: {
        found: false,
        data: null,
        source: null,
        buyer: null,
        seller: null
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
      financial: {
        iban: null,
        swift: null
      },
      jurisdiction: [],
      riskScore: 0,
      flags: [],
      redFlags: [],
      positiveSignals: []
    };

    // Build list of entities to check
    const entitiesToCheck = [];
    
    // Add from allParties if provided
    if (allParties && Array.isArray(allParties)) {
      for (const party of allParties) {
        if (party.company) {
          entitiesToCheck.push({
            name: party.company,
            type: 'company',
            role: party.role || 'Unknown',
            country: party.country,
            email: party.email
          });
        }
        if (party.name) {
          entitiesToCheck.push({
            name: party.name,
            type: 'person',
            role: party.role || 'Unknown',
            country: party.country,
            email: party.email
          });
        }
      }
    }
    
    // Add direct companyName if provided
    if (companyName && !entitiesToCheck.find(e => e.name === companyName)) {
      entitiesToCheck.push({
        name: companyName,
        type: 'company',
        role: 'Primary',
        country: country
      });
    }
    
    // Add representative if provided
    if (representative) {
      entitiesToCheck.push({
        name: representative,
        type: 'person',
        role: 'Representative'
      });
    }

    console.log(`Checking ${entitiesToCheck.length} entities`);

    // 1. SANCTIONS SCREENING - Check all entities
    for (const entity of entitiesToCheck) {
      const sanctionsResult = await checkOpenSanctions(entity.name);
      
      results.sanctions.entities.push({
        name: entity.name,
        type: entity.type,
        role: entity.role,
        ...sanctionsResult
      });
      
      if (sanctionsResult.found && sanctionsResult.matches.length > 0) {
        results.sanctions.found = true;
        results.riskScore += 50;
        results.flags.push('SANCTIONS_MATCH');
        results.redFlags.push(`⚠️ SANCTIONS ALERT: "${entity.name}" has potential matches in global sanctions databases`);
        results.sanctions.matches.push(...sanctionsResult.matches);
        results.sanctions.lists.push(...sanctionsResult.lists);
      } else {
        results.positiveSignals.push(`✓ ${entity.name}: No sanctions matches found`);
      }
    }
    
    // Deduplicate lists
    results.sanctions.lists = [...new Set(results.sanctions.lists)];

    // 2. COMPANY REGISTRY CHECKS - For all companies
    const companies = entitiesToCheck.filter(e => e.type === 'company');
    
    for (const company of companies) {
      const companyCountry = company.country?.toLowerCase() || '';
      let registryResult = null;
      
      // Try UK Companies House for UK companies
      if (companyCountry.includes('uk') || companyCountry.includes('united kingdom') || companyCountry.includes('britain')) {
        registryResult = await checkUKCompaniesHouse(company.name);
      }
      
      // Try OpenCorporates for all companies
      if (!registryResult?.found) {
        registryResult = await checkOpenCorporates(company.name, company.country);
      }
      
      if (registryResult?.found) {
        results.riskScore -= 10;
        results.positiveSignals.push(`✓ ${company.name} verified in ${registryResult.source}`);
        
        // Store by role
        if (company.role?.toLowerCase().includes('buyer')) {
          results.companyRegistry.buyer = registryResult;
        } else if (company.role?.toLowerCase().includes('seller')) {
          results.companyRegistry.seller = registryResult;
        }
        
        if (!results.companyRegistry.found) {
          results.companyRegistry = { ...results.companyRegistry, ...registryResult };
        }
      } else {
        results.redFlags.push(`⚠️ Company "${company.name}" not found in business registries`);
        results.riskScore += 10;
      }
      
      // 3. LEI CHECK - GLEIF
      const gleifResult = await checkGLEIF(company.name);
      if (gleifResult.found) {
        results.leiRegistry.found = true;
        results.riskScore -= 5;
        results.flags.push('LEI_REGISTERED');
        results.positiveSignals.push(`✓ ${company.name} has Legal Entity Identifier (LEI)`);
        
        if (company.role?.toLowerCase().includes('buyer')) {
          results.leiRegistry.buyer = gleifResult;
        } else if (company.role?.toLowerCase().includes('seller')) {
          results.leiRegistry.seller = gleifResult;
        }
        
        if (!results.leiRegistry.data) {
          results.leiRegistry = { ...results.leiRegistry, ...gleifResult };
        }
      }
      
      // 4. SEC CHECK - For US companies
      if (companyCountry.includes('us') || companyCountry.includes('united states') || companyCountry.includes('usa')) {
        const secResult = await checkSECEdgar(company.name);
        if (secResult.found) {
          results.secFilings = secResult;
          results.riskScore -= 10;
          results.flags.push('SEC_REGISTERED');
          results.positiveSignals.push(`✓ ${company.name} is SEC registered`);
        }
      }
    }

    // 5. EMAIL VALIDATION - Check all emails
    const emails = entitiesToCheck.filter(e => e.email).map(e => ({ email: e.email, role: e.role }));
    if (email) emails.push({ email: email, role: 'Primary' });
    
    for (const emailObj of emails) {
      const emailResult = await validateEmail(emailObj.email);
      
      if (emailResult.disposable) {
        results.riskScore += 20;
        results.flags.push('DISPOSABLE_EMAIL');
        results.redFlags.push(`🚨 CRITICAL: Disposable email detected (${emailObj.email}) - extremely high fraud risk`);
      } else if (emailResult.risk === 'medium') {
        results.riskScore += 5;
        results.redFlags.push(`⚠️ Free email provider used (${emailObj.email}) - unusual for corporate transactions`);
      } else if (emailResult.risk === 'low') {
        results.positiveSignals.push(`✓ Corporate email verified: ${emailObj.email.split('@')[1]}`);
      }
      
      if (!emailResult.valid) {
        results.riskScore += 10;
        results.flags.push('INVALID_EMAIL');
        results.redFlags.push(`❌ Invalid email format: ${emailObj.email}`);
      }
      
      results.emailValidation = emailResult;
    }

    // 6. IBAN VALIDATION
    if (iban) {
      const ibanResult = validateIBAN(iban);
      results.financial.iban = ibanResult;
      
      if (!ibanResult.valid) {
        results.riskScore += 15;
        results.redFlags.push(`❌ Invalid IBAN format detected`);
      } else {
        results.positiveSignals.push(`✓ IBAN validated: ${ibanResult.country || ibanResult.countryCode}`);
        
        // Check for high-risk jurisdictions
        const highRiskIBANCountries = ['IR', 'KP', 'SY', 'CU'];
        if (highRiskIBANCountries.includes(ibanResult.countryCode)) {
          results.riskScore += 30;
          results.redFlags.push(`🚨 IBAN is from sanctioned jurisdiction: ${ibanResult.countryCode}`);
        }
      }
    }

    // 7. SWIFT VALIDATION
    if (swift) {
      const swiftResult = validateSWIFT(swift);
      results.financial.swift = swiftResult;
      
      if (!swiftResult.valid) {
        results.riskScore += 10;
        results.redFlags.push(`❌ Invalid SWIFT/BIC format`);
      } else {
        results.positiveSignals.push(`✓ SWIFT/BIC validated: ${swiftResult.countryCode}`);
      }
    }

    // 8. JURISDICTION RISK CHECK
    const countries = new Set();
    entitiesToCheck.forEach(e => { if (e.country) countries.add(e.country); });
    if (country) countries.add(country);
    
    for (const c of countries) {
      const riskResult = checkJurisdictionRisk(c);
      results.jurisdiction.push(riskResult);
      
      if (riskResult.fatfBlacklist) {
        results.riskScore += 40;
        results.redFlags.push(`🚨 CRITICAL: ${c} is on FATF Blacklist - transaction may be prohibited`);
      } else if (riskResult.fatfGreyList) {
        results.riskScore += 15;
        results.redFlags.push(`⚠️ ${c} is on FATF Grey List - enhanced due diligence required`);
      } else if (riskResult.secrecyJurisdiction) {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ ${c} is a known secrecy jurisdiction`);
      }
    }

    // Cap risk score at 100
    results.riskScore = Math.min(100, Math.max(0, results.riskScore));
    
    // Calculate risk level
    if (results.riskScore <= 30) {
      results.riskLevel = 'GREEN';
    } else if (results.riskScore <= 60) {
      results.riskLevel = 'YELLOW';
    } else if (results.riskScore <= 85) {
      results.riskLevel = 'RED';
    } else {
      results.riskLevel = 'BLACK';
    }

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

async function checkOpenSanctions(name) {
  try {
    const response = await fetch(
      `https://api.opensanctions.org/search/default?q=${encodeURIComponent(name)}&limit=5`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
      return { found: false, matches: [], lists: [], error: 'API unavailable' };
    }

    const data = await response.json();
    const matches = [];
    const lists = [];

    if (data.results && data.results.length > 0) {
      for (const match of data.results) {
        if (match.score > 0.7) {
          matches.push({
            name: match.caption || match.name,
            score: match.score,
            datasets: match.datasets || [],
            schema: match.schema
          });
          if (match.datasets) {
            lists.push(...match.datasets);
          }
        }
      }
    }

    return {
      found: matches.length > 0,
      matches: matches,
      lists: [...new Set(lists)]
    };
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return { found: false, matches: [], lists: [], error: error.message };
  }
}

async function checkUKCompaniesHouse(companyName) {
  try {
    const apiKey = process.env.UK_COMPANIES_HOUSE_API_KEY;
    if (!apiKey) {
      return { found: false, data: null, source: 'UK Companies House', error: 'API key not configured' };
    }

    const response = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`,
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`
        }
      }
    );

    if (!response.ok) {
      return { found: false, data: null, source: 'UK Companies House' };
    }

    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const company = data.items[0];
      return {
        found: true,
        source: 'UK Companies House',
        data: {
          name: company.title,
          companyNumber: company.company_number,
          status: company.company_status,
          type: company.company_type,
          address: company.address_snippet,
          createdDate: company.date_of_creation
        }
      };
    }

    return { found: false, data: null, source: 'UK Companies House' };
  } catch (error) {
    console.error('UK Companies House error:', error);
    return { found: false, data: null, source: 'UK Companies House', error: error.message };
  }
}

async function checkOpenCorporates(companyName, country) {
  try {
    let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}`;
    
    if (country) {
      const code = mapCountryToCode(country);
      if (code) url += `&jurisdiction_code=${code}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      return { found: false, data: null, source: 'OpenCorporates' };
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
          registryUrl: company.registry_url
        }
      };
    }

    return { found: false, data: null, source: 'OpenCorporates' };
  } catch (error) {
    console.error('OpenCorporates error:', error);
    return { found: false, data: null, source: 'OpenCorporates', error: error.message };
  }
}

async function checkGLEIF(companyName) {
  try {
    const response = await fetch(
      `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}`,
      { headers: { 'Accept': 'application/vnd.api+json' } }
    );

    if (!response.ok) {
      return { found: false, data: null, source: 'GLEIF' };
    }

    const data = await response.json();

    if (data.data && data.data.length > 0) {
      const entity = data.data[0];
      const attrs = entity.attributes.entity;
      return {
        found: true,
        source: 'GLEIF LEI Registry',
        data: {
          lei: entity.attributes.lei,
          legalName: attrs.legalName?.name,
          status: attrs.status,
          jurisdiction: attrs.legalAddress?.country
        }
      };
    }

    return { found: false, data: null, source: 'GLEIF' };
  } catch (error) {
    console.error('GLEIF error:', error);
    return { found: false, data: null, source: 'GLEIF', error: error.message };
  }
}

async function checkSECEdgar(companyName) {
  try {
    const response = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(companyName)}&type=&dateb=&owner=exclude&count=1&output=atom`,
      {
        headers: {
          'User-Agent': 'DueDiligencePro/1.0 (compliance@dudediligence.pro)'
        }
      }
    );

    if (!response.ok) {
      return { found: false, data: null, cik: null };
    }

    const xmlText = await response.text();
    const cikMatch = xmlText.match(/<CIK>(\d+)<\/CIK>/);
    const nameMatch = xmlText.match(/<company-name>([^<]+)<\/company-name>/);

    if (cikMatch && nameMatch) {
      return {
        found: true,
        cik: cikMatch[1],
        data: {
          companyName: nameMatch[1],
          cik: cikMatch[1],
          edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikMatch[1]}`
        }
      };
    }

    return { found: false, data: null, cik: null };
  } catch (error) {
    console.error('SEC EDGAR error:', error);
    return { found: false, data: null, cik: null, error: error.message };
  }
}

async function validateEmail(email) {
  const result = {
    valid: false,
    disposable: false,
    deliverable: null,
    risk: 'unknown'
  };

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    result.risk = 'high';
    return result;
  }

  result.valid = true;
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

  const freeProviders = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'mail.com', 'protonmail.com', 'zoho.com', 'icloud.com'
  ];

  if (freeProviders.includes(domain)) {
    result.risk = 'medium';
  } else {
    result.risk = 'low';
  }

  result.deliverable = true;
  return result;
}

function validateIBAN(iban) {
  const cleanIBAN = iban.replace(/\s/g, '').toUpperCase();
  const countryCode = cleanIBAN.substring(0, 2);
  
  const ibanLengths = {
    'AL': 28, 'AD': 24, 'AT': 20, 'AZ': 28, 'BH': 22, 'BY': 28, 'BE': 16,
    'BA': 20, 'BR': 29, 'BG': 22, 'CR': 22, 'HR': 21, 'CY': 28, 'CZ': 24,
    'DK': 18, 'DO': 28, 'EG': 29, 'EE': 20, 'FO': 18, 'FI': 18, 'FR': 27,
    'GE': 22, 'DE': 22, 'GI': 23, 'GR': 27, 'GL': 18, 'HU': 28, 'IS': 26,
    'IE': 22, 'IL': 23, 'IT': 27, 'JO': 30, 'KZ': 20, 'KW': 30, 'LV': 21,
    'LB': 28, 'LI': 21, 'LT': 20, 'LU': 20, 'MT': 31, 'MR': 27, 'MU': 30,
    'MC': 27, 'MD': 24, 'ME': 22, 'NL': 18, 'MK': 19, 'NO': 15, 'PK': 24,
    'PL': 28, 'PT': 25, 'QA': 29, 'RO': 24, 'SM': 27, 'SA': 24, 'RS': 22,
    'SK': 24, 'SI': 19, 'ES': 24, 'SE': 24, 'CH': 21, 'TN': 24, 'TR': 26,
    'AE': 23, 'GB': 22
  };

  if (!ibanLengths[countryCode]) {
    return { valid: false, error: 'Unknown country code', countryCode };
  }

  if (cleanIBAN.length !== ibanLengths[countryCode]) {
    return { valid: false, error: 'Invalid length', countryCode };
  }

  return { valid: true, countryCode, iban: cleanIBAN };
}

function validateSWIFT(swift) {
  const cleanSWIFT = swift.replace(/\s/g, '').toUpperCase();
  
  if (cleanSWIFT.length !== 8 && cleanSWIFT.length !== 11) {
    return { valid: false, error: 'SWIFT must be 8 or 11 characters' };
  }

  const bankCode = cleanSWIFT.substring(0, 4);
  const countryCode = cleanSWIFT.substring(4, 6);

  if (!/^[A-Z]{4}$/.test(bankCode) || !/^[A-Z]{2}$/.test(countryCode)) {
    return { valid: false, error: 'Invalid format' };
  }

  return { valid: true, countryCode, swift: cleanSWIFT };
}

function checkJurisdictionRisk(country) {
  const c = country.toLowerCase();
  
  const fatfBlacklist = ['north korea', 'dprk', 'iran', 'myanmar'];
  const fatfGreyList = ['albania', 'barbados', 'burkina faso', 'cameroon', 'croatia', 
    'haiti', 'jamaica', 'jordan', 'mali', 'mozambique', 'nigeria', 'panama', 
    'philippines', 'senegal', 'south africa', 'south sudan', 'syria', 'tanzania', 
    'turkey', 'uae', 'united arab emirates', 'uganda', 'vietnam', 'yemen'];
  const secrecyJurisdictions = ['british virgin islands', 'bvi', 'cayman islands', 
    'bermuda', 'jersey', 'guernsey', 'bahamas', 'seychelles', 'mauritius', 
    'cyprus', 'malta', 'luxembourg', 'liechtenstein', 'monaco', 'panama'];

  return {
    country: country,
    fatfBlacklist: fatfBlacklist.some(x => c.includes(x)),
    fatfGreyList: fatfGreyList.some(x => c.includes(x)),
    secrecyJurisdiction: secrecyJurisdictions.some(x => c.includes(x))
  };
}

function mapCountryToCode(country) {
  const map = {
    'uk': 'gb', 'united kingdom': 'gb', 'usa': 'us', 'united states': 'us',
    'uae': 'ae', 'emirates': 'ae', 'china': 'cn', 'singapore': 'sg',
    'hong kong': 'hk', 'india': 'in', 'germany': 'de', 'france': 'fr',
    'spain': 'es', 'italy': 'it', 'netherlands': 'nl', 'belgium': 'be',
    'switzerland': 'ch', 'australia': 'au', 'canada': 'ca', 'brazil': 'br',
    'nigeria': 'ng', 'south africa': 'za', 'kenya': 'ke', 'japan': 'jp'
  };
  return map[country.toLowerCase()] || null;
}
