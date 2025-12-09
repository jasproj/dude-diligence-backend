// Full Due Diligence API - Real Database Checks (v3)
// Integrates: OpenSanctions, UK Companies House, OpenCorporates, GLEIF, SEC EDGAR,
//             ICIJ Offshore Leaks (Panama Papers), World Bank Debarred,
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
      offshoreLeaks: {
        found: false,
        matches: [],
        datasets: [],
        totalResults: 0
      },
      worldBankDebarred: {
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
      positiveSignals: [],
      databasesChecked: []
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
      results.databasesChecked.push('OpenSanctions');
      
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
        results.databasesChecked.push('Interpol Red Notices');
        
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

      // --- ICIJ OFFSHORE LEAKS CHECK (Panama Papers, Paradise Papers, Pandora Papers) ---
      const offshoreResult = await checkICIJOffshoreLeaks(entity.name);
      results.databasesChecked.push('ICIJ Offshore Leaks');
      
      if (offshoreResult.found) {
        results.offshoreLeaks.found = true;
        results.offshoreLeaks.matches.push({
          searchedName: entity.name,
          role: entity.role,
          matches: offshoreResult.matches
        });
        results.offshoreLeaks.totalResults += offshoreResult.totalResults || 0;
        if (offshoreResult.datasets) {
          results.offshoreLeaks.datasets = [...new Set([...results.offshoreLeaks.datasets, ...offshoreResult.datasets])];
        }
        results.riskScore += 35;
        results.redFlags.push(`🚨 ${entity.name}: Found in ICIJ Offshore Leaks database (Panama Papers/Paradise Papers/Pandora Papers)`);
      }

      // --- WORLD BANK DEBARRED CHECK ---
      if (entity.type === 'company') {
        const wbResult = await checkWorldBankDebarred(entity.name);
        results.databasesChecked.push('World Bank Debarred');
        
        if (wbResult.found) {
          results.worldBankDebarred.found = true;
          results.worldBankDebarred.matches.push({
            searchedName: entity.name,
            role: entity.role,
            matches: wbResult.matches
          });
          results.worldBankDebarred.totalResults += wbResult.totalResults || 0;
          results.riskScore += 40;
          results.redFlags.push(`🚨 ${entity.name}: Debarred by World Bank - banned from World Bank projects`);
        }
      }

      // --- COMPANY REGISTRY CHECKS (for companies) ---
      if (entity.type === 'company') {
        const entityCountry = entity.country || country;
        const countryCode = mapCountryToCode(entityCountry);
        
        // UK Companies House
        if (countryCode === 'GB' || countryCode === 'UK') {
          const ukResult = await checkUKCompaniesHouse(entity.name);
          results.databasesChecked.push('UK Companies House');
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
        results.databasesChecked.push('OpenCorporates');
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
        results.databasesChecked.push('GLEIF LEI Registry');
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
          results.databasesChecked.push('SEC EDGAR');
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
        results.databasesChecked.push('Email Validation');
        
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
      results.databasesChecked.push('Jurisdiction Risk');
      
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
    if (results.sanctions.found || results.interpol.found || results.offshoreLeaks.found || results.worldBankDebarred.found) {
      results.riskLevel = results.riskLevel === 'GREEN' ? 'RED' : results.riskLevel;
      if (results.interpol.found || (results.sanctions.found && results.sanctions.matches.length > 0)) {
        results.riskLevel = 'BLACK';
        results.riskScore = Math.min(results.riskScore, 25);
      }
    }

    // Deduplicate
    results.sanctions.lists = [...new Set(results.sanctions.lists)];
    results.databasesChecked = [...new Set(results.databasesChecked)];

    return res.status(200).json(results);

  } catch (error) {
    console.error('Full diligence API error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message,
      riskLevel: 'YELLOW',
      riskScore: 50,
      flags: ['System error - manual verification required']
    });
  }
}


// ============================================
// INTERPOL RED NOTICES
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
        headers: { 'Accept': 'application/json' }
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
// ICIJ OFFSHORE LEAKS DATABASE
// Panama Papers, Paradise Papers, Pandora Papers
// ============================================

async function checkICIJOffshoreLeaks(name) {
  try {
    // ICIJ Reconciliation API - the correct endpoint for searching
    // Documentation: https://offshoreleaks.icij.org/docs/reconciliation
    const response = await fetch(
      'https://offshoreleaks.icij.org/api/v1/reconcile',
      { 
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'DDP/1.0 Due Diligence Platform'
        },
        body: JSON.stringify({
          query: name,
          type: 'Entity'  // Search for offshore entities
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      // Reconciliation API returns { result: [...] }
      if (data.result && data.result.length > 0) {
        // Filter for reasonable matches (score > 50 out of 100)
        const significantMatches = data.result.filter(m => m.score > 50).slice(0, 5);
        
        if (significantMatches.length > 0) {
          return {
            found: true,
            matches: significantMatches.map(hit => ({
              name: hit.name,
              id: hit.id,
              type: hit.type?.[0] || 'Entity',
              score: hit.score
            })),
            totalResults: significantMatches.length,
            source: 'ICIJ Offshore Leaks',
            datasets: ['Panama Papers', 'Paradise Papers', 'Pandora Papers', 'Offshore Leaks']
          };
        }
      }
    }

    // Also try searching for Officers (people associated with offshore entities)
    const officerResponse = await fetch(
      'https://offshoreleaks.icij.org/api/v1/reconcile',
      { 
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: name,
          type: 'Officer'  // Search for officers/directors
        })
      }
    );

    if (officerResponse.ok) {
      const officerData = await officerResponse.json();
      
      if (officerData.result && officerData.result.length > 0) {
        const significantMatches = officerData.result.filter(m => m.score > 50).slice(0, 5);
        
        if (significantMatches.length > 0) {
          return {
            found: true,
            matches: significantMatches.map(hit => ({
              name: hit.name,
              id: hit.id,
              type: 'Officer',
              score: hit.score
            })),
            totalResults: significantMatches.length,
            source: 'ICIJ Offshore Leaks',
            datasets: ['Panama Papers', 'Paradise Papers', 'Pandora Papers']
          };
        }
      }
    }

    return { found: false, matches: [], source: 'ICIJ Offshore Leaks' };
  } catch (error) {
    console.error('ICIJ Offshore Leaks error:', error);
    return { found: false, matches: [], error: error.message, source: 'ICIJ Offshore Leaks' };
  }
}


// ============================================
// WORLD BANK DEBARRED LIST
// ============================================

async function checkWorldBankDebarred(name) {
  try {
    // Note: OpenSanctions includes World Bank debarred firms data
    // This is an additional direct check against the World Bank source
    
    // Try the World Bank Socrata API
    const response = await fetch(
      `https://finances.worldbank.org/resource/kvtn-9wxx.json?$q=${encodeURIComponent(name)}&$limit=10`,
      { 
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'DDP/1.0'
        }
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      if (data && data.length > 0) {
        // Filter for close matches
        const searchLower = name.toLowerCase();
        const matches = data.filter(d => {
          const firmName = (d.firm_name || '').toLowerCase();
          return firmName.includes(searchLower) || searchLower.includes(firmName) ||
                 levenshteinDistance(firmName, searchLower) < 5;
        });

        if (matches.length > 0) {
          return {
            found: true,
            matches: matches.slice(0, 5).map(d => ({
              firmName: d.firm_name,
              country: d.country,
              grounds: d.grounds,
              fromDate: d.from_date,
              toDate: d.to_date,
              address: d.address
            })),
            totalResults: matches.length,
            source: 'World Bank Debarred Firms'
          };
        }
      }
    }

    // Alternative: Check via OpenSanctions World Bank dataset
    // OpenSanctions includes World Bank debarred firms in their aggregated data
    // So matches would appear in the main OpenSanctions check as well
    
    return { found: false, matches: [], source: 'World Bank Debarred Firms', note: 'Also checked via OpenSanctions' };
  } catch (error) {
    console.error('World Bank Debarred error:', error);
    return { found: false, matches: [], error: error.message, source: 'World Bank Debarred Firms' };
  }
}


// ============================================
// OPENSANCTIONS WITH PEP DETECTION
// ============================================

async function checkOpenSanctions(name) {
  try {
    console.log(`OpenSanctions: Searching for "${name}"`);
    
    // First try the search API (works for both persons and entities)
    const searchResponse = await fetch(
      `https://api.opensanctions.org/search/default?q=${encodeURIComponent(name)}&limit=10`,
      { headers: { 'Accept': 'application/json' } }
    );
    
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      console.log(`OpenSanctions: Found ${searchData.results?.length || 0} results for "${name}"`);
      
      if (searchData.results && searchData.results.length > 0) {
        // Log all results for debugging
        searchData.results.forEach((r, i) => {
          console.log(`  Result ${i+1}: ${r.caption} (score: ${r.score}, datasets: ${r.datasets?.join(', ')})`);
        });
        
        // Filter for significant matches (score > 0.3 - lowered to catch more matches)
        const significantMatches = searchData.results.filter(m => m.score >= 0.3);
        
        if (significantMatches.length > 0) {
          const isPEP = significantMatches.some(m => 
            m.datasets?.some(d => d.toLowerCase().includes('pep')) ||
            m.topics?.includes('role.pep')
          );
          
          // Check for criminal/wanted status
          const isWanted = significantMatches.some(m =>
            m.datasets?.some(d => 
              d.toLowerCase().includes('interpol') ||
              d.toLowerCase().includes('fbi') ||
              d.toLowerCase().includes('wanted') ||
              d.toLowerCase().includes('crime')
            ) ||
            m.topics?.some(t => t.includes('crime') || t.includes('wanted'))
          );
          
          return {
            found: true,
            matches: significantMatches.slice(0, 5).map(m => ({
              name: m.caption || m.name,
              schema: m.schema,
              datasets: m.datasets,
              score: m.score,
              topics: m.topics
            })),
            lists: [...new Set(significantMatches.flatMap(m => m.datasets || []))],
            isPEP: isPEP,
            pepType: isPEP ? 'Politically Exposed Person' : null,
            isWanted: isWanted
          };
        }
      }
    }

    // Fallback: Try match API for LegalEntity
    const response = await fetch(
      `https://api.opensanctions.org/match/default?schema=LegalEntity`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          queries: {
            q1: {
              schema: 'LegalEntity',
              properties: {
                name: [name]
              }
            }
          }
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      if (data.responses?.q1?.results && data.responses.q1.results.length > 0) {
        const results = data.responses.q1.results;
        const significantMatches = results.filter(r => r.score >= 0.3);
        
        if (significantMatches.length > 0) {
          const isPEP = significantMatches.some(m => 
            m.datasets?.some(d => d.toLowerCase().includes('pep')) ||
            m.properties?.topics?.some(t => t.includes('pep'))
          );
          
          return {
            found: true,
            matches: significantMatches.slice(0, 5).map(m => ({
              name: m.caption,
              schema: m.schema,
              datasets: m.datasets,
              score: m.score,
              properties: m.properties
            })),
            lists: [...new Set(significantMatches.flatMap(m => m.datasets || []))],
            isPEP: isPEP,
            pepType: isPEP ? 'Politically Exposed Person' : null,
            pepDatasets: isPEP ? significantMatches.flatMap(m => m.datasets || []).filter(d => d.toLowerCase().includes('pep')) : []
          };
        }
      }
    }

    return { found: false, matches: [], lists: [] };
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return { found: false, matches: [], lists: [], error: error.message };
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
      return { found: false };
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
          registeredAddress: company.registered_address_in_full
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
// GLEIF (LEI REGISTRY)
// ============================================

async function checkGLEIF(companyName) {
  try {
    const response = await fetch(
      `https://api.gleif.org/api/v1/lei-records?filter[entity.legalName]=${encodeURIComponent(companyName)}&page[size]=5`,
      {
        headers: { 'Accept': 'application/vnd.api+json' }
      }
    );

    if (!response.ok) {
      return { found: false };
    }

    const data = await response.json();
    
    if (data.data && data.data.length > 0) {
      const record = data.data[0];
      return {
        found: true,
        lei: record.attributes.lei,
        entity: {
          name: record.attributes.entity?.legalName?.name,
          jurisdiction: record.attributes.entity?.jurisdiction,
          status: record.attributes.entity?.status,
          legalForm: record.attributes.entity?.legalForm?.id
        },
        registration: {
          status: record.attributes.registration?.status,
          initialRegistrationDate: record.attributes.registration?.initialRegistrationDate,
          lastUpdateDate: record.attributes.registration?.lastUpdateDate
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
    'tempail.com', 'dispostable.com', 'mintemail.com', 'mt2009.com',
    'tempinbox.com', 'fakemailgenerator.com', 'emailondeck.com',
    'getnada.com', 'mohmal.com', 'tempmailo.com', 'burnermail.io',
    'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org',
    'spam4.me', 'grr.la', 'mailnesia.com', 'tempr.email'
  ];

  if (disposableProviders.includes(domain) || domain.includes('temp') || domain.includes('disposable')) {
    result.disposable = true;
    result.valid = false;
  } else if (freeProviders.includes(domain)) {
    result.freeProvider = true;
    result.valid = true;
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
  const cleanIban = iban.replace(/\s/g, '').toUpperCase();
  
  const ibanLengths = {
    'AL': 28, 'AD': 24, 'AT': 20, 'AZ': 28, 'BH': 22, 'BY': 28, 'BE': 16, 'BA': 20,
    'BR': 29, 'BG': 22, 'CR': 22, 'HR': 21, 'CY': 28, 'CZ': 24, 'DK': 18, 'DO': 28,
    'TL': 23, 'EE': 20, 'FO': 18, 'FI': 18, 'FR': 27, 'GE': 22, 'DE': 22, 'GI': 23,
    'GR': 27, 'GL': 18, 'GT': 28, 'HU': 28, 'IS': 26, 'IQ': 23, 'IE': 22, 'IL': 23,
    'IT': 27, 'JO': 30, 'KZ': 20, 'XK': 20, 'KW': 30, 'LV': 21, 'LB': 28, 'LI': 21,
    'LT': 20, 'LU': 20, 'MT': 31, 'MR': 27, 'MU': 30, 'MC': 27, 'MD': 24, 'ME': 22,
    'NL': 18, 'MK': 19, 'NO': 15, 'PK': 24, 'PS': 29, 'PL': 28, 'PT': 25, 'QA': 29,
    'RO': 24, 'SM': 27, 'SA': 24, 'RS': 22, 'SK': 24, 'SI': 19, 'ES': 24, 'SE': 24,
    'CH': 21, 'TN': 24, 'TR': 26, 'AE': 23, 'GB': 22, 'VA': 22, 'VG': 24
  };

  const countryCode = cleanIban.substring(0, 2);
  const expectedLength = ibanLengths[countryCode];

  if (!expectedLength) {
    return { valid: false, error: 'Unknown country code', country: countryCode };
  }

  if (cleanIban.length !== expectedLength) {
    return { valid: false, error: 'Invalid length', country: countryCode, expected: expectedLength, actual: cleanIban.length };
  }

  // Basic format check (should start with 2 letters, then 2 digits)
  if (!/^[A-Z]{2}[0-9]{2}/.test(cleanIban)) {
    return { valid: false, error: 'Invalid format', country: countryCode };
  }

  return {
    valid: true,
    country: countryCode,
    bankCode: cleanIban.substring(4, 8),
    formatted: cleanIban.match(/.{1,4}/g).join(' ')
  };
}


// ============================================
// SWIFT/BIC VALIDATION
// ============================================

function validateSWIFT(swift) {
  const cleanSwift = swift.replace(/\s/g, '').toUpperCase();

  // SWIFT is 8 or 11 characters
  if (cleanSwift.length !== 8 && cleanSwift.length !== 11) {
    return { valid: false, error: 'SWIFT must be 8 or 11 characters' };
  }

  // First 4: Bank code (letters)
  // Next 2: Country code (letters)
  // Next 2: Location code (alphanumeric)
  // Last 3 (optional): Branch code (alphanumeric)
  
  const bankCode = cleanSwift.substring(0, 4);
  const countryCode = cleanSwift.substring(4, 6);
  const locationCode = cleanSwift.substring(6, 8);
  const branchCode = cleanSwift.length === 11 ? cleanSwift.substring(8, 11) : null;

  if (!/^[A-Z]{4}$/.test(bankCode)) {
    return { valid: false, error: 'Invalid bank code' };
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { valid: false, error: 'Invalid country code' };
  }

  return {
    valid: true,
    bankCode: bankCode,
    countryCode: countryCode,
    locationCode: locationCode,
    branchCode: branchCode,
    formatted: cleanSwift
  };
}


// ============================================
// JURISDICTION RISK CHECK
// ============================================

function checkJurisdictionRisk(country) {
  if (!country) return { country: 'Unknown', risk: 'unknown' };
  
  const countryLower = country.toLowerCase().trim();
  
  // FATF Blacklist (High-Risk Jurisdictions)
  const fatfBlacklist = ['iran', 'north korea', 'dprk', 'myanmar', 'burma'];
  
  // FATF Greylist (Increased Monitoring)
  const fatfGreylist = [
    'uae', 'united arab emirates', 'emirates', 'dubai', 'abu dhabi',
    'turkey', 'türkiye', 'turkiye',
    'south africa',
    'syria',
    'yemen',
    'nigeria',
    'pakistan',
    'philippines',
    'barbados',
    'burkina faso',
    'cameroon',
    'democratic republic of congo', 'drc',
    'gibraltar',
    'haiti',
    'jamaica',
    'jordan',
    'mali',
    'mozambique',
    'panama',
    'senegal',
    'south sudan',
    'tanzania',
    'uganda',
    'vietnam'
  ];
  
  // Comprehensively Sanctioned Countries
  const sanctionedCountries = [
    'russia', 'russian federation',
    'belarus',
    'iran',
    'north korea', 'dprk',
    'syria',
    'cuba',
    'venezuela',
    'crimea',
    'donetsk', 'luhansk',
    'myanmar', 'burma'
  ];
  
  // High Secrecy Jurisdictions (Tax Justice Network)
  const highSecrecy = [
    'switzerland',
    'luxembourg',
    'cayman islands', 'caymans',
    'singapore',
    'hong kong',
    'jersey',
    'guernsey',
    'isle of man',
    'british virgin islands', 'bvi',
    'bermuda',
    'bahamas',
    'mauritius',
    'liechtenstein',
    'monaco',
    'andorra',
    'panama',
    'seychelles',
    'marshall islands',
    'delaware', 'usa' // Partial
  ];
  
  return {
    country: country,
    fatfBlacklist: fatfBlacklist.some(c => countryLower.includes(c)),
    fatfGreylist: fatfGreylist.some(c => countryLower.includes(c)),
    sanctioned: sanctionedCountries.some(c => countryLower.includes(c)),
    highSecrecy: highSecrecy.some(c => countryLower.includes(c)),
    risk: fatfBlacklist.some(c => countryLower.includes(c)) ? 'critical' :
          sanctionedCountries.some(c => countryLower.includes(c)) ? 'critical' :
          fatfGreylist.some(c => countryLower.includes(c)) ? 'high' :
          highSecrecy.some(c => countryLower.includes(c)) ? 'medium' : 'low'
  };
}


// ============================================
// COUNTRY CODE MAPPING
// ============================================

function mapCountryToCode(country) {
  if (!country) return null;
  
  const countryLower = country.toLowerCase().trim();
  
  const countryMap = {
    'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
    'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
    'germany': 'DE', 'deutschland': 'DE',
    'france': 'FR',
    'italy': 'IT',
    'spain': 'ES',
    'netherlands': 'NL', 'holland': 'NL',
    'belgium': 'BE',
    'switzerland': 'CH',
    'austria': 'AT',
    'sweden': 'SE',
    'norway': 'NO',
    'denmark': 'DK',
    'finland': 'FI',
    'ireland': 'IE',
    'portugal': 'PT',
    'greece': 'GR',
    'poland': 'PL',
    'czech republic': 'CZ', 'czechia': 'CZ',
    'hungary': 'HU',
    'romania': 'RO',
    'bulgaria': 'BG',
    'croatia': 'HR',
    'slovakia': 'SK',
    'slovenia': 'SI',
    'estonia': 'EE',
    'latvia': 'LV',
    'lithuania': 'LT',
    'luxembourg': 'LU',
    'malta': 'MT',
    'cyprus': 'CY',
    'canada': 'CA',
    'australia': 'AU',
    'new zealand': 'NZ',
    'japan': 'JP',
    'south korea': 'KR', 'korea': 'KR',
    'china': 'CN',
    'india': 'IN',
    'brazil': 'BR',
    'mexico': 'MX',
    'argentina': 'AR',
    'chile': 'CL',
    'colombia': 'CO',
    'peru': 'PE',
    'south africa': 'ZA',
    'nigeria': 'NG',
    'kenya': 'KE',
    'egypt': 'EG',
    'morocco': 'MA',
    'uae': 'AE', 'united arab emirates': 'AE', 'dubai': 'AE', 'abu dhabi': 'AE',
    'saudi arabia': 'SA',
    'qatar': 'QA',
    'kuwait': 'KW',
    'bahrain': 'BH',
    'oman': 'OM',
    'israel': 'IL',
    'turkey': 'TR', 'türkiye': 'TR',
    'russia': 'RU', 'russian federation': 'RU',
    'ukraine': 'UA',
    'singapore': 'SG',
    'hong kong': 'HK',
    'taiwan': 'TW',
    'thailand': 'TH',
    'malaysia': 'MY',
    'indonesia': 'ID',
    'philippines': 'PH',
    'vietnam': 'VN',
    'pakistan': 'PK',
    'bangladesh': 'BD',
    'iran': 'IR',
    'iraq': 'IQ',
    'syria': 'SY',
    'lebanon': 'LB',
    'jordan': 'JO',
    'cayman islands': 'KY',
    'british virgin islands': 'VG', 'bvi': 'VG',
    'bermuda': 'BM',
    'bahamas': 'BS',
    'panama': 'PA',
    'luxembourg': 'LU',
    'liechtenstein': 'LI',
    'monaco': 'MC',
    'andorra': 'AD',
    'jersey': 'JE',
    'guernsey': 'GG',
    'isle of man': 'IM'
  };
  
  return countryMap[countryLower] || country.substring(0, 2).toUpperCase();
}
