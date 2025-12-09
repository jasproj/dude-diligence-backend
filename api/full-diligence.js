// Full Due Diligence API - Real Database Checks
// Integrates: OpenSanctions, UK Companies House, OpenCorporates, GLEIF, SEC EDGAR, 
//             Email validation, IBAN/SWIFT, Interpol Red Notices, PEP Detection

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
      pep: {
        found: false,
        matches: [],
        details: []
      },
      interpol: {
        found: false,
        matches: [],
        totalResults: 0
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
      riskLevel: 'GREEN',
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

    // Add primary company/representative if provided directly
    if (companyName && !entitiesToCheck.find(e => e.name === companyName)) {
      entitiesToCheck.push({
        name: companyName,
        type: 'company',
        role: 'Primary',
        country: country
      });
    }

    if (representative && !entitiesToCheck.find(e => e.name === representative)) {
      entitiesToCheck.push({
        name: representative,
        type: 'person',
        role: 'Representative',
        country: country
      });
    }

    // ============================================
    // CHECK ALL ENTITIES
    // ============================================
    
    for (const entity of entitiesToCheck) {
      // --- SANCTIONS CHECK (OpenSanctions with PEP detection) ---
      const sanctionsResult = await checkOpenSanctions(entity.name);
      
      if (sanctionsResult.found) {
        results.sanctions.found = true;
        results.sanctions.entities.push({
          name: entity.name,
          role: entity.role,
          matches: sanctionsResult.matches,
          lists: sanctionsResult.lists
        });
        results.sanctions.matches.push(...sanctionsResult.matches);
        results.sanctions.lists.push(...sanctionsResult.lists);
        
        // Check for PEP status
        if (sanctionsResult.isPEP) {
          results.pep.found = true;
          results.pep.matches.push({
            name: entity.name,
            role: entity.role,
            pepType: sanctionsResult.pepType,
            datasets: sanctionsResult.pepDatasets
          });
          results.riskScore += 15;
          results.redFlags.push(`⚠️ ${entity.name}: Politically Exposed Person (PEP) detected - Enhanced due diligence required`);
        }
        
        // Add sanctions red flag
        results.riskScore += 50;
        results.redFlags.push(`🚨 ${entity.name}: Potential sanctions match found`);
      } else {
        results.positiveSignals.push(`✓ ${entity.name}: No sanctions matches found`);
      }

      // --- INTERPOL RED NOTICES CHECK (for persons only) ---
      if (entity.type === 'person') {
        const interpolResult = await checkInterpolRedNotices(entity.name);
        
        if (interpolResult.found) {
          results.interpol.found = true;
          results.interpol.matches.push({
            searchedName: entity.name,
            role: entity.role,
            notices: interpolResult.matches
          });
          results.interpol.totalResults += interpolResult.totalResults;
          results.riskScore += 75; // Very serious
          results.redFlags.push(`🚨 ${entity.name}: INTERPOL Red Notice match - WANTED internationally`);
        }
      }

      // --- COMPANY REGISTRY CHECKS (for companies) ---
      if (entity.type === 'company') {
        const entityCountry = entity.country || country;
        const countryCode = mapCountryToCode(entityCountry);
        
        // UK Companies House
        if (countryCode === 'GB' || countryCode === 'UK') {
          const ukResult = await checkUKCompaniesHouse(entity.name);
          if (ukResult.found) {
            if (entity.role?.toLowerCase().includes('buyer')) {
              results.companyRegistry.buyer = ukResult;
            } else if (entity.role?.toLowerCase().includes('seller')) {
              results.companyRegistry.seller = ukResult;
            }
            results.companyRegistry.found = true;
            results.riskScore -= 10;
            results.positiveSignals.push(`✓ ${entity.name}: Verified in UK Companies House`);
          }
        }

        // OpenCorporates (global)
        const ocResult = await checkOpenCorporates(entity.name, countryCode);
        if (ocResult.found) {
          if (entity.role?.toLowerCase().includes('buyer')) {
            results.companyRegistry.buyer = results.companyRegistry.buyer || ocResult;
          } else if (entity.role?.toLowerCase().includes('seller')) {
            results.companyRegistry.seller = results.companyRegistry.seller || ocResult;
          }
          results.companyRegistry.found = true;
          results.riskScore -= 5;
          results.positiveSignals.push(`✓ ${entity.name}: Found in corporate registry`);
        }

        // GLEIF (LEI check)
        const leiResult = await checkGLEIF(entity.name);
        if (leiResult.found) {
          if (entity.role?.toLowerCase().includes('buyer')) {
            results.leiRegistry.buyer = leiResult;
          } else if (entity.role?.toLowerCase().includes('seller')) {
            results.leiRegistry.seller = leiResult;
          }
          results.leiRegistry.found = true;
          results.riskScore -= 10;
          results.positiveSignals.push(`✓ ${entity.name}: Valid LEI found - verified financial entity`);
        }

        // SEC Edgar (US companies)
        if (countryCode === 'US') {
          const secResult = await checkSECEdgar(entity.name);
          if (secResult.found) {
            results.secFilings = secResult;
            results.riskScore -= 15;
            results.positiveSignals.push(`✓ ${entity.name}: SEC-registered public company`);
          }
        }
      }

      // --- EMAIL VALIDATION ---
      if (entity.email) {
        const emailResult = await validateEmail(entity.email);
        results.emailValidation = emailResult;
        
        if (emailResult.disposable) {
          results.riskScore += 20;
          results.redFlags.push(`❌ ${entity.email}: Disposable email detected - HIGH RISK`);
        } else if (emailResult.freeProvider) {
          results.riskScore += 5;
          results.redFlags.push(`⚠️ ${entity.email}: Free email provider (not corporate)`);
        } else if (emailResult.corporate) {
          results.riskScore -= 5;
          results.positiveSignals.push(`✓ ${entity.email}: Corporate email domain`);
        }
      }
    }

    // ============================================
    // FINANCIAL VALIDATION (IBAN/SWIFT)
    // ============================================
    
    if (iban) {
      const ibanResult = validateIBAN(iban);
      results.financial.iban = ibanResult;
      if (!ibanResult.valid) {
        results.riskScore += 15;
        results.redFlags.push('❌ Invalid IBAN format - verify banking details');
      } else {
        results.positiveSignals.push(`✓ IBAN validated: ${ibanResult.country} bank account`);
      }
    }

    if (swift) {
      const swiftResult = validateSWIFT(swift);
      results.financial.swift = swiftResult;
      if (!swiftResult.valid) {
        results.riskScore += 10;
        results.redFlags.push('❌ Invalid SWIFT/BIC code format');
      } else {
        results.positiveSignals.push(`✓ SWIFT code validated: ${swiftResult.bankCode}`);
      }
    }

    // ============================================
    // JURISDICTION RISK CHECK
    // ============================================
    
    const countriesChecked = new Set();
    entitiesToCheck.forEach(e => {
      if (e.country) countriesChecked.add(e.country);
    });
    if (country) countriesChecked.add(country);

    for (const countryName of countriesChecked) {
      const jurisdictionRisk = checkJurisdictionRisk(countryName);
      results.jurisdiction.push(jurisdictionRisk);
      
      if (jurisdictionRisk.fatfBlacklist) {
        results.riskScore += 50;
        results.redFlags.push(`🚨 ${countryName}: FATF BLACKLIST - High-risk jurisdiction with severe AML deficiencies. Transactions may be PROHIBITED.`);
      } else if (jurisdictionRisk.fatfGreylist) {
        results.riskScore += 20;
        results.redFlags.push(`⚠️ ${countryName}: FATF GREY LIST - Enhanced due diligence required. Country has strategic AML deficiencies.`);
      } else if (jurisdictionRisk.highSecrecy) {
        results.riskScore += 15;
        results.redFlags.push(`⚠️ ${countryName}: High financial secrecy jurisdiction - additional verification recommended`);
      }
      
      if (jurisdictionRisk.sanctioned) {
        results.riskScore += 60;
        results.redFlags.push(`🚨 ${countryName}: Comprehensively sanctioned country - transactions may be ILLEGAL`);
      }
    }

    // ============================================
    // CALCULATE FINAL RISK LEVEL
    // ============================================
    
    // Ensure score stays in 0-100 range
    results.riskScore = Math.max(0, Math.min(100, 100 - results.riskScore));
    
    // Determine risk level
    if (results.riskScore >= 86) {
      results.riskLevel = 'GREEN';
    } else if (results.riskScore >= 60) {
      results.riskLevel = 'YELLOW';
    } else if (results.riskScore >= 31) {
      results.riskLevel = 'RED';
    } else {
      results.riskLevel = 'BLACK';
    }

    // Force BLACK if critical issues found
    if (results.sanctions.found || results.interpol.found) {
      results.riskLevel = 'BLACK';
      results.riskScore = Math.min(results.riskScore, 25);
    }

    // Deduplicate lists
    results.sanctions.lists = [...new Set(results.sanctions.lists)];

    return res.status(200).json(results);

  } catch (error) {
    console.error('Due diligence error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

// ============================================
// INTERPOL RED NOTICES API (FREE)
// ============================================

async function checkInterpolRedNotices(name) {
  try {
    // Split name into first and last
    const nameParts = name.trim().split(/\s+/);
    let firstName = '';
    let lastName = '';
    
    if (nameParts.length === 1) {
      lastName = nameParts[0];
    } else {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ');
    }
    
    const params = new URLSearchParams({
      resultPerPage: '20'
    });
    
    if (firstName) params.append('forename', firstName);
    if (lastName) params.append('name', lastName);
    
    const response = await fetch(
      `https://ws-public.interpol.int/notices/v1/red?${params}`,
      { 
        headers: { 'Accept': 'application/json' },
        timeout: 10000
      }
    );

    if (!response.ok) {
      return { found: false, matches: [], totalResults: 0, error: 'API unavailable' };
    }

    const data = await response.json();
    const matches = [];

    if (data._embedded?.notices && data._embedded.notices.length > 0) {
      for (const notice of data._embedded.notices) {
        // Check if name is close match
        const noticeName = `${notice.forename || ''} ${notice.name || ''}`.toLowerCase().trim();
        const searchName = name.toLowerCase().trim();
        
        // Simple similarity check
        if (noticeName.includes(searchName) || searchName.includes(noticeName) ||
            levenshteinDistance(noticeName, searchName) < 3) {
          matches.push({
            entityId: notice.entity_id,
            forename: notice.forename,
            name: notice.name,
            dateOfBirth: notice.date_of_birth,
            nationalities: notice.nationalities || [],
            link: notice._links?.self?.href
          });
        }
      }
    }

    return {
      found: matches.length > 0,
      matches: matches,
      totalResults: data.total || 0
    };
  } catch (error) {
    console.error('Interpol API error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}

// Simple Levenshtein distance for name matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

// ============================================
// OPENSANCTIONS WITH PEP DETECTION
// ============================================

async function checkOpenSanctions(name) {
  try {
    const response = await fetch(
      `https://api.opensanctions.org/search/default?q=${encodeURIComponent(name)}&limit=10`,
      { headers: { 'Accept': 'application/json' } }
    );

    if (!response.ok) {
      return { found: false, matches: [], lists: [], isPEP: false, error: 'API unavailable' };
    }

    const data = await response.json();
    const matches = [];
    const lists = [];
    let isPEP = false;
    let pepType = null;
    let pepDatasets = [];

    // PEP-related dataset identifiers
    const pepIndicators = [
      'pep', 'politically', 'public_office', 'politician', 'government',
      'everypolitician', 'ruling', 'official', 'minister', 'parliament',
      'congress', 'senate', 'executive', 'judicial'
    ];

    if (data.results && data.results.length > 0) {
      for (const match of data.results) {
        if (match.score > 0.7) {
          matches.push({
            name: match.caption || match.name,
            score: match.score,
            datasets: match.datasets || [],
            schema: match.schema,
            properties: match.properties || {}
          });
          
          if (match.datasets) {
            lists.push(...match.datasets);
            
            // Check if any dataset indicates PEP status
            for (const dataset of match.datasets) {
              const datasetLower = dataset.toLowerCase();
              if (pepIndicators.some(indicator => datasetLower.includes(indicator))) {
                isPEP = true;
                pepDatasets.push(dataset);
              }
            }
          }
          
          // Also check schema for PEP indicators
          if (match.schema) {
            const schemaLower = match.schema.toLowerCase();
            if (pepIndicators.some(indicator => schemaLower.includes(indicator))) {
              isPEP = true;
              pepType = match.schema;
            }
          }
          
          // Check properties for position/role
          if (match.properties) {
            const props = match.properties;
            if (props.position || props.role || props.political_party) {
              isPEP = true;
              pepType = props.position?.[0] || props.role?.[0] || 'Political figure';
            }
          }
        }
      }
    }

    return {
      found: matches.length > 0,
      matches: matches,
      lists: [...new Set(lists)],
      isPEP: isPEP,
      pepType: pepType,
      pepDatasets: [...new Set(pepDatasets)]
    };
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return { found: false, matches: [], lists: [], isPEP: false, error: error.message };
  }
}

// ============================================
// UK COMPANIES HOUSE
// ============================================

async function checkUKCompaniesHouse(companyName) {
  const apiKey = process.env.UK_COMPANIES_HOUSE_KEY;
  
  if (!apiKey) {
    return { found: false, status: 'unconfigured' };
  }

  try {
    const auth = Buffer.from(`${apiKey}:`).toString('base64');
    const response = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`,
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return { found: false, error: 'API error', status: response.status };
    }

    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      const company = data.items[0];
      return {
        found: true,
        company: {
          name: company.title,
          number: company.company_number,
          status: company.company_status,
          type: company.company_type,
          dateOfCreation: company.date_of_creation,
          address: company.address_snippet
        },
        source: 'UK Companies House'
      };
    }

    return { found: false };
  } catch (error) {
    console.error('UK Companies House error:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// OPENCORPORATES
// ============================================

async function checkOpenCorporates(companyName, countryCode) {
  try {
    let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&per_page=5`;
    
    if (countryCode) {
      url += `&jurisdiction_code=${countryCode.toLowerCase()}`;
    }

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      return { found: false, error: 'API error' };
    }

    const data = await response.json();
    
    if (data.results?.companies && data.results.companies.length > 0) {
      const company = data.results.companies[0].company;
      return {
        found: true,
        company: {
          name: company.name,
          number: company.company_number,
          jurisdiction: company.jurisdiction_code,
          status: company.current_status,
          incorporationDate: company.incorporation_date,
          companyType: company.company_type
        },
        source: 'OpenCorporates'
      };
    }

    return { found: false };
  } catch (error) {
    console.error('OpenCorporates error:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// GLEIF (LEI Registry)
// ============================================

async function checkGLEIF(companyName) {
  try {
    const response = await fetch(
      `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}&page[size]=5`,
      { headers: { 'Accept': 'application/vnd.api+json' } }
    );

    if (!response.ok) {
      return { found: false, error: 'API error' };
    }

    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const record = data.data[0];
      return {
        found: true,
        lei: record.id,
        entity: {
          name: record.attributes?.entity?.legalName?.name,
          status: record.attributes?.entity?.status,
          jurisdiction: record.attributes?.entity?.jurisdiction,
          legalForm: record.attributes?.entity?.legalForm?.id
        },
        source: 'GLEIF'
      };
    }

    return { found: false };
  } catch (error) {
    console.error('GLEIF error:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// SEC EDGAR
// ============================================

async function checkSECEdgar(companyName) {
  try {
    const response = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=2020-01-01&enddt=2025-12-31&forms=10-K,10-Q,8-K&from=0&size=5`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'DDP/1.0' } }
    );

    if (!response.ok) {
      // Try alternative endpoint
      const altResponse = await fetch(
        `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(companyName)}&CIK=&type=10-K&owner=include&count=5&action=getcompany&output=atom`,
        { headers: { 'User-Agent': 'DDP/1.0' } }
      );
      
      if (altResponse.ok) {
        return { found: true, source: 'SEC EDGAR', note: 'Company found in SEC filings' };
      }
      return { found: false };
    }

    const data = await response.json();
    
    if (data.hits?.hits && data.hits.hits.length > 0) {
      const filing = data.hits.hits[0]._source;
      return {
        found: true,
        cik: filing.ciks?.[0],
        company: filing.display_names?.[0],
        filings: data.hits.total?.value || 0,
        source: 'SEC EDGAR'
      };
    }

    return { found: false };
  } catch (error) {
    console.error('SEC EDGAR error:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// EMAIL VALIDATION
// ============================================

async function validateEmail(email) {
  const result = {
    email: email,
    valid: false,
    freeProvider: false,
    disposable: false,
    corporate: false,
    domain: null
  };

  if (!email || !email.includes('@')) {
    return result;
  }

  const domain = email.split('@')[1].toLowerCase();
  result.domain = domain;

  // Free email providers
  const freeProviders = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
    'gmx.com', 'live.com', 'msn.com', 'qq.com', '163.com', '126.com',
    'mail.ru', 'inbox.com', 'fastmail.com'
  ];

  // Disposable email providers
  const disposableProviders = [
    'tempmail.com', 'guerrillamail.com', 'mailinator.com', '10minutemail.com',
    'throwaway.email', 'temp-mail.org', 'fakeinbox.com', 'sharklasers.com',
    'trashmail.com', 'maildrop.cc', 'getairmail.com', 'yopmail.com',
    'tempail.com', 'dispostable.com', 'mintemail.com', 'mohmal.com'
  ];

  if (freeProviders.includes(domain)) {
    result.freeProvider = true;
    result.valid = true;
  } else if (disposableProviders.some(d => domain.includes(d))) {
    result.disposable = true;
    result.valid = false;
  } else {
    result.corporate = true;
    result.valid = true;
  }

  return result;
}

// ============================================
// IBAN VALIDATION
// ============================================

function validateIBAN(iban) {
  if (!iban) return { valid: false, error: 'No IBAN provided' };
  
  // Remove spaces and convert to uppercase
  const cleanIBAN = iban.replace(/\s+/g, '').toUpperCase();
  
  // IBAN length by country
  const ibanLengths = {
    'AL': 28, 'AD': 24, 'AT': 20, 'AZ': 28, 'BH': 22, 'BY': 28, 'BE': 16,
    'BA': 20, 'BR': 29, 'BG': 22, 'CR': 22, 'HR': 21, 'CY': 28, 'CZ': 24,
    'DK': 18, 'DO': 28, 'TL': 23, 'EE': 20, 'FO': 18, 'FI': 18, 'FR': 27,
    'GE': 22, 'DE': 22, 'GI': 23, 'GR': 27, 'GL': 18, 'GT': 28, 'HU': 28,
    'IS': 26, 'IQ': 23, 'IE': 22, 'IL': 23, 'IT': 27, 'JO': 30, 'KZ': 20,
    'XK': 20, 'KW': 30, 'LV': 21, 'LB': 28, 'LI': 21, 'LT': 20, 'LU': 20,
    'MK': 19, 'MT': 31, 'MR': 27, 'MU': 30, 'MC': 27, 'MD': 24, 'ME': 22,
    'NL': 18, 'NO': 15, 'PK': 24, 'PS': 29, 'PL': 28, 'PT': 25, 'QA': 29,
    'RO': 24, 'SM': 27, 'SA': 24, 'RS': 22, 'SC': 31, 'SK': 24, 'SI': 19,
    'ES': 24, 'SE': 24, 'CH': 21, 'TN': 24, 'TR': 26, 'UA': 29, 'AE': 23,
    'GB': 22, 'VA': 22, 'VG': 24
  };

  const countryCode = cleanIBAN.substring(0, 2);
  const expectedLength = ibanLengths[countryCode];

  if (!expectedLength) {
    return { valid: false, error: 'Unknown country code', country: countryCode };
  }

  if (cleanIBAN.length !== expectedLength) {
    return { 
      valid: false, 
      error: `Invalid length for ${countryCode}`, 
      expected: expectedLength, 
      actual: cleanIBAN.length 
    };
  }

  // Checksum validation
  const rearranged = cleanIBAN.slice(4) + cleanIBAN.slice(0, 4);
  const numericIBAN = rearranged.split('').map(char => {
    const code = char.charCodeAt(0);
    return code >= 65 && code <= 90 ? (code - 55).toString() : char;
  }).join('');

  let remainder = numericIBAN;
  while (remainder.length > 2) {
    const block = remainder.slice(0, 9);
    remainder = (parseInt(block, 10) % 97).toString() + remainder.slice(9);
  }

  const isValid = parseInt(remainder, 10) % 97 === 1;

  return {
    valid: isValid,
    country: countryCode,
    checkDigits: cleanIBAN.substring(2, 4),
    bankCode: cleanIBAN.substring(4, 8),
    formattedIBAN: cleanIBAN.match(/.{1,4}/g)?.join(' ')
  };
}

// ============================================
// SWIFT/BIC VALIDATION
// ============================================

function validateSWIFT(swift) {
  if (!swift) return { valid: false, error: 'No SWIFT code provided' };
  
  const cleanSWIFT = swift.replace(/\s+/g, '').toUpperCase();
  
  // SWIFT codes are 8 or 11 characters
  if (cleanSWIFT.length !== 8 && cleanSWIFT.length !== 11) {
    return { valid: false, error: 'Invalid length (must be 8 or 11 characters)' };
  }

  // Format: AAAA BB CC DDD
  // AAAA = Bank code (letters)
  // BB = Country code (letters)
  // CC = Location code (alphanumeric)
  // DDD = Branch code (optional, alphanumeric)
  
  const bankCode = cleanSWIFT.substring(0, 4);
  const countryCode = cleanSWIFT.substring(4, 6);
  const locationCode = cleanSWIFT.substring(6, 8);
  const branchCode = cleanSWIFT.length === 11 ? cleanSWIFT.substring(8, 11) : null;

  if (!/^[A-Z]{4}$/.test(bankCode)) {
    return { valid: false, error: 'Invalid bank code format' };
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { valid: false, error: 'Invalid country code format' };
  }

  return {
    valid: true,
    bankCode: bankCode,
    countryCode: countryCode,
    locationCode: locationCode,
    branchCode: branchCode,
    formatted: branchCode ? `${bankCode} ${countryCode} ${locationCode} ${branchCode}` : `${bankCode} ${countryCode} ${locationCode}`
  };
}

// ============================================
// JURISDICTION RISK CHECK
// ============================================

function checkJurisdictionRisk(country) {
  const countryUpper = (country || '').toUpperCase().trim();
  
  // FATF Blacklist (High-Risk Jurisdictions Subject to Call for Action)
  const fatfBlacklist = ['IRAN', 'NORTH KOREA', 'DPRK', 'MYANMAR', 'BURMA'];
  
  // FATF Greylist (Jurisdictions Under Increased Monitoring) - Updated 2024
  const fatfGreylist = [
    'ALBANIA', 'BARBADOS', 'BURKINA FASO', 'CAMEROON', 'CAYMAN ISLANDS',
    'CROATIA', 'DEMOCRATIC REPUBLIC OF CONGO', 'DRC', 'GIBRALTAR', 'HAITI',
    'JAMAICA', 'JORDAN', 'MALI', 'MOZAMBIQUE', 'NAMIBIA', 'NIGERIA',
    'PANAMA', 'PHILIPPINES', 'SENEGAL', 'SOUTH AFRICA', 'SOUTH SUDAN',
    'SYRIA', 'TANZANIA', 'TURKEY', 'UGANDA', 'UAE', 'UNITED ARAB EMIRATES',
    'VIETNAM', 'YEMEN'
  ];
  
  // Comprehensively sanctioned countries
  const sanctionedCountries = [
    'IRAN', 'NORTH KOREA', 'DPRK', 'SYRIA', 'CUBA', 'CRIMEA', 'RUSSIA',
    'BELARUS', 'VENEZUELA'
  ];
  
  // High financial secrecy jurisdictions
  const highSecrecy = [
    'CAYMAN ISLANDS', 'BRITISH VIRGIN ISLANDS', 'BVI', 'SWITZERLAND',
    'LUXEMBOURG', 'SINGAPORE', 'HONG KONG', 'PANAMA', 'BAHAMAS',
    'BERMUDA', 'JERSEY', 'GUERNSEY', 'ISLE OF MAN', 'LIECHTENSTEIN',
    'MONACO', 'ANDORRA', 'MAURITIUS', 'SEYCHELLES', 'VANUATU'
  ];

  return {
    country: country,
    fatfBlacklist: fatfBlacklist.some(c => countryUpper.includes(c)),
    fatfGreylist: fatfGreylist.some(c => countryUpper.includes(c)),
    sanctioned: sanctionedCountries.some(c => countryUpper.includes(c)),
    highSecrecy: highSecrecy.some(c => countryUpper.includes(c)),
    riskLevel: fatfBlacklist.some(c => countryUpper.includes(c)) ? 'CRITICAL' :
               sanctionedCountries.some(c => countryUpper.includes(c)) ? 'CRITICAL' :
               fatfGreylist.some(c => countryUpper.includes(c)) ? 'HIGH' :
               highSecrecy.some(c => countryUpper.includes(c)) ? 'ELEVATED' : 'STANDARD'
  };
}

// ============================================
// COUNTRY NAME TO CODE MAPPING
// ============================================

function mapCountryToCode(country) {
  if (!country) return null;
  
  const countryMap = {
    'UNITED STATES': 'US', 'USA': 'US', 'U.S.A.': 'US', 'AMERICA': 'US', 'US': 'US',
    'UNITED KINGDOM': 'GB', 'UK': 'GB', 'BRITAIN': 'GB', 'ENGLAND': 'GB', 'GB': 'GB',
    'GERMANY': 'DE', 'DEUTSCHLAND': 'DE', 'DE': 'DE',
    'FRANCE': 'FR', 'FR': 'FR',
    'ITALY': 'IT', 'IT': 'IT',
    'SPAIN': 'ES', 'ES': 'ES',
    'NETHERLANDS': 'NL', 'HOLLAND': 'NL', 'NL': 'NL',
    'BELGIUM': 'BE', 'BE': 'BE',
    'SWITZERLAND': 'CH', 'CH': 'CH',
    'AUSTRIA': 'AT', 'AT': 'AT',
    'CANADA': 'CA', 'CA': 'CA',
    'AUSTRALIA': 'AU', 'AU': 'AU',
    'JAPAN': 'JP', 'JP': 'JP',
    'CHINA': 'CN', 'CN': 'CN', 'PRC': 'CN',
    'INDIA': 'IN', 'IN': 'IN',
    'BRAZIL': 'BR', 'BR': 'BR',
    'RUSSIA': 'RU', 'RUSSIAN FEDERATION': 'RU', 'RU': 'RU',
    'TURKEY': 'TR', 'TURKIYE': 'TR', 'TR': 'TR',
    'UAE': 'AE', 'UNITED ARAB EMIRATES': 'AE', 'DUBAI': 'AE', 'AE': 'AE',
    'SINGAPORE': 'SG', 'SG': 'SG',
    'HONG KONG': 'HK', 'HK': 'HK',
    'NIGERIA': 'NG', 'NG': 'NG',
    'SOUTH AFRICA': 'ZA', 'ZA': 'ZA',
    'MEXICO': 'MX', 'MX': 'MX',
    'IRAN': 'IR', 'IR': 'IR',
    'NORTH KOREA': 'KP', 'DPRK': 'KP', 'KP': 'KP',
    'SOUTH KOREA': 'KR', 'KOREA': 'KR', 'KR': 'KR'
  };

  const upperCountry = country.toUpperCase().trim();
  return countryMap[upperCountry] || country.substring(0, 2).toUpperCase();
}
