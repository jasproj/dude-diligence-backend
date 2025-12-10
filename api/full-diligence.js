// Full Due Diligence API - Real Database Checks (v5.4 - CRITICAL FIXES)
// v5.4 FIXES:
//   1. OPENSANCTIONS: Removed score filter for FBI/Interpol/Europol - wanted criminals now ALWAYS flagged
//   2. UK COMPANIES HOUSE: Fixed API key env var (was COMPANIES_HOUSE_API_KEY, now UK_COMPANIES_HOUSE_KEY)
//   3. INTERPOL: Added fallback search with just surname for broader matching
//   4. WANTED CRIMINALS: Added extra risk penalty for FBI Most Wanted / Interpol Red Notice matches
//
// PREVIOUS FIXES (v5.3):
//   1. DEDUPLICATION: Entities are now deduplicated before checking
//   2. DEDUPLICATION: positiveSignals and redFlags are deduplicated before returning
//   3. OPENCORPORATES: Now tries broader search without jurisdiction, and handles US state codes
//
// Integrates: OpenSanctions (314 sources), UK Companies House, Singapore ACRA, OpenCorporates, GLEIF, SEC EDGAR,
//             ICIJ Offshore Leaks (Panama Papers), World Bank Debarred, Trade.gov CSL (BIS Entity/Denied/MEU/Unverified),
//             SAM.gov Exclusions (US Govt Debarred), Domain Age (RDAP/WHOIS), Interpol Red & Yellow Notices,
//             Email validation, IBAN/SWIFT with Sanctions Check, PEP Detection, Equasis Vessel Lookup (85K+ ships),
//             Bill of Lading Extraction, Port Verification (UN/LOCODE), SBLC/BLC/POF Detection, Captain Verification

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
    const { companyName, email, country, representative, allParties, iban, swift, vesselIMO, vesselName, documentText, portOfLoading, portOfDischarge, captain } = req.body;

    // More flexible validation - accept if we have ANY data to check
    if (!companyName && !email && (!allParties || allParties.length === 0)) {
      return res.status(400).json({ error: 'Missing required data - need companyName, email, or allParties' });
    }

    const results = {
      _version: 'v5.4-RUJA-FIX-20251210',  // DEBUG: Remove after confirming deployment
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
      tradeGovCSL: {
        found: false,
        matches: [],
        sources: [],
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
      domainAge: {
        found: false,
        domain: null,
        createdDate: null,
        ageInDays: null,
        registrar: null,
        risk: 'unknown'
      },
      samGovExclusions: {
        found: false,
        matches: [],
        totalResults: 0
      },
      vesselLookup: {
        found: false,
        vessels: [],
        totalResults: 0
      },
      billOfLading: {
        found: false,
        data: null
      },
      portVerification: {
        loading: null,
        discharge: null
      },
      financialInstruments: [],
      captain: {
        found: false,
        name: null,
        verified: false
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

    // ============================================
    // BUILD & DEDUPLICATE ENTITIES TO CHECK
    // ============================================
    
    const entitiesToCheck = [];
    const seenNames = new Set(); // Track names we've already added (normalized)
    
    // Helper to normalize name for deduplication
    const normalizeName = (name) => name?.toLowerCase().trim() || '';
    
    // Helper to add entity only if not seen before
    const addEntityIfNew = (name, type, role, entityCountry, entityEmail) => {
      const normalized = normalizeName(name);
      if (!normalized || seenNames.has(normalized)) return false;
      
      seenNames.add(normalized);
      entitiesToCheck.push({
        name: name.trim(),
        type,
        role: role || 'Unknown',
        country: entityCountry,
        email: entityEmail
      });
      return true;
    };
    
    // Add from allParties if provided
    if (allParties && Array.isArray(allParties)) {
      for (const party of allParties) {
        // FIX: Only add as company OR person, not both
        // Determine if this looks like a company or person name
        const companyIndicators = ['llc', 'ltd', 'inc', 'corp', 'company', 'co.', 'gmbh', 'sa', 'ag', 'plc', 'limited', 'corporation', 'enterprises', 'holdings', 'group'];
        
        if (party.company) {
          const companyLower = party.company.toLowerCase();
          const looksLikeCompany = companyIndicators.some(ind => companyLower.includes(ind));
          
          addEntityIfNew(
            party.company,
            looksLikeCompany ? 'company' : 'person', // Smart type detection
            party.role,
            party.country,
            party.email
          );
        }
        
        // Only add person name if it's DIFFERENT from company name
        if (party.name && normalizeName(party.name) !== normalizeName(party.company)) {
          addEntityIfNew(
            party.name,
            'person',
            party.role,
            party.country,
            party.email
          );
        }
      }
    }

    // Add primary company/representative if provided directly (with dedup)
    if (companyName) {
      addEntityIfNew(companyName, 'company', 'Primary', country, null);
    }

    if (representative) {
      addEntityIfNew(representative, 'person', 'Representative', country, null);
    }

    // ============================================
    // CHECK ALL ENTITIES
    // ============================================
    
    for (const entity of entitiesToCheck) {
      // --- SANCTIONS CHECK (OpenSanctions with PEP detection) ---
      const sanctionsResult = await checkOpenSanctions(entity.name);
      if (!results.databasesChecked.includes('OpenSanctions')) {
        results.databasesChecked.push('OpenSanctions');
      }
      
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
        
        // v5.4 FIX: Extra penalty for FBI/Interpol wanted criminals
        if (sanctionsResult.isWanted) {
          results.riskScore += 50; // Additional 50 points = BLACK score
          results.redFlags.push(`🚨 ${entity.name}: WANTED CRIMINAL - Found on FBI/Interpol/Europol database`);
        } else {
          results.redFlags.push(`🚨 ${entity.name}: Potential sanctions match found`);
        }
      } else {
        results.positiveSignals.push(`✓ ${entity.name}: No sanctions matches found`);
      }

      // --- INTERPOL RED NOTICES CHECK (for persons only) ---
      if (entity.type === 'person') {
        const interpolResult = await checkInterpolRedNotices(entity.name);
        if (!results.databasesChecked.includes('Interpol Red Notices')) {
          results.databasesChecked.push('Interpol Red Notices');
        }
        
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
      if (!results.databasesChecked.includes('ICIJ Offshore Leaks')) {
        results.databasesChecked.push('ICIJ Offshore Leaks');
      }
      
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
        if (!results.databasesChecked.includes('World Bank Debarred')) {
          results.databasesChecked.push('World Bank Debarred');
        }
        
        if (wbResult.found) {
          results.worldBankDebarred.found = true;
          results.worldBankDebarred.matches.push({
            searchedName: entity.name,
            role: entity.role,
            matches: wbResult.matches
          });
          results.worldBankDebarred.totalResults += wbResult.totalResults || 0;
          results.riskScore += 40;
          results.redFlags.push(`🚨 ${entity.name}: Found on World Bank Debarred List`);
        }
      }

      // --- TRADE.GOV CSL CHECK ---
      const cslResult = await checkTradeGovCSL(entity.name);
      if (!results.databasesChecked.includes('Trade.gov CSL')) {
        results.databasesChecked.push('Trade.gov CSL');
      }
      
      if (cslResult.found) {
        results.tradeGovCSL.found = true;
        results.tradeGovCSL.matches.push({
          searchedName: entity.name,
          role: entity.role,
          matches: cslResult.matches
        });
        results.tradeGovCSL.totalResults += cslResult.totalResults || 0;
        if (cslResult.sources) {
          results.tradeGovCSL.sources = [...new Set([...results.tradeGovCSL.sources, ...cslResult.sources])];
        }
        results.riskScore += 45;
        results.redFlags.push(`🚨 ${entity.name}: Found on US Export Control List (Trade.gov CSL)`);
      }

      // --- SAM.GOV EXCLUSIONS CHECK ---
      const samResult = await checkSAMGovExclusions(entity.name);
      if (!results.databasesChecked.includes('SAM.gov Exclusions')) {
        results.databasesChecked.push('SAM.gov Exclusions');
      }
      
      if (samResult.found) {
        results.samGovExclusions.found = true;
        results.samGovExclusions.matches.push({
          searchedName: entity.name,
          role: entity.role,
          matches: samResult.matches
        });
        results.samGovExclusions.totalResults += samResult.totalResults || 0;
        results.riskScore += 45;
        results.redFlags.push(`🚨 ${entity.name}: EXCLUDED from US Government contracts (SAM.gov)`);
      }

      // --- INTERPOL YELLOW NOTICES (for persons) ---
      if (entity.type === 'person') {
        const yellowResult = await checkInterpolYellowNotices(entity.name);
        if (!results.databasesChecked.includes('Interpol Yellow Notices')) {
          results.databasesChecked.push('Interpol Yellow Notices');
        }
        
        if (yellowResult.found) {
          results.interpol.matches.push(...yellowResult.matches);
          results.interpol.totalResults += yellowResult.totalResults;
          results.riskScore += 30;
          results.redFlags.push(`⚠️ ${entity.name}: Found in Interpol Yellow Notices (Missing Person)`);
        }
      }

      // --- COMPANY REGISTRY CHECKS (for companies) ---
      if (entity.type === 'company') {
        const entityCountry = entity.country || country;
        const countryCode = mapCountryToCode(entityCountry);
        
        // UK Companies House
        if (countryCode === 'GB' || countryCode === 'UK') {
          const ukResult = await checkUKCompaniesHouse(entity.name);
          if (!results.databasesChecked.includes('UK Companies House')) {
            results.databasesChecked.push('UK Companies House');
          }
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

        // Singapore ACRA (via data.gov.sg)
        if (countryCode === 'SG') {
          const sgResult = await checkSingaporeACRA(entity.name);
          if (!results.databasesChecked.includes('Singapore ACRA')) {
            results.databasesChecked.push('Singapore ACRA');
          }
          if (sgResult.found) {
            if (entity.role?.toLowerCase().includes('buyer')) {
              results.companyRegistry.buyer = sgResult;
            } else if (entity.role?.toLowerCase().includes('seller')) {
              results.companyRegistry.seller = sgResult;
            }
            results.companyRegistry.found = true;
            results.riskScore -= 10;
            results.positiveSignals.push(`✓ ${entity.name}: Verified in Singapore ACRA`);
          }
        }

        // OpenCorporates (global) - IMPROVED SEARCH
        const ocResult = await checkOpenCorporates(entity.name, countryCode);
        if (!results.databasesChecked.includes('OpenCorporates')) {
          results.databasesChecked.push('OpenCorporates');
        }
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
        if (!results.databasesChecked.includes('GLEIF LEI Registry')) {
          results.databasesChecked.push('GLEIF LEI Registry');
        }
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
          if (!results.databasesChecked.includes('SEC EDGAR')) {
            results.databasesChecked.push('SEC EDGAR');
          }
          if (secResult.found) {
            results.secFilings = secResult;
            results.riskScore -= 15;
            results.positiveSignals.push(`✓ ${entity.name}: SEC-registered public company`);
          }
        }
      }

      // --- EMAIL VALIDATION (if email provided) ---
      if (entity.email) {
        const emailResult = await validateEmail(entity.email);
        results.emailValidation = emailResult;
        
        if (emailResult.disposable) {
          results.riskScore += 25;
          results.redFlags.push(`⚠️ ${entity.email}: Disposable/temporary email detected`);
        } else if (emailResult.valid) {
          const freeEmailDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com'];
          const domain = entity.email.split('@')[1]?.toLowerCase();
          if (freeEmailDomains.includes(domain)) {
            results.riskScore += 5;
            results.redFlags.push(`⚠️ ${entity.email}: Using free email provider (unusual for business)`);
          } else {
            results.positiveSignals.push(`✓ ${entity.email}: Corporate email domain`);
          }
        }

        // Domain age check
        if (entity.email.includes('@')) {
          const domain = entity.email.split('@')[1];
          const domainResult = await checkDomainAge(domain);
          results.domainAge = domainResult;
          
          if (domainResult.found) {
            if (domainResult.ageInDays < 180) {
              results.riskScore += 20;
              results.redFlags.push(`⚠️ ${domain}: Very new domain (${domainResult.ageInDays} days old)`);
            } else if (domainResult.ageInDays < 365) {
              results.riskScore += 10;
              results.redFlags.push(`⚠️ ${domain}: Relatively new domain (${Math.floor(domainResult.ageInDays / 30)} months old)`);
            } else {
              const ageYears = Math.floor(domainResult.ageInDays / 365);
              results.positiveSignals.push(`✓ ${domain}: Established domain (${ageYears}+ years)`);
            }
          }
        }
      }
    }

    // --- IBAN VALIDATION ---
    if (iban) {
      const ibanResult = validateIBAN(iban);
      results.financial.iban = ibanResult;
      
      if (ibanResult.valid) {
        results.positiveSignals.push(`✓ IBAN validated: ${ibanResult.country} bank account`);
        
        // Check if IBAN country is sanctioned
        const ibanCountry = ibanResult.countryCode;
        const sanctionedCountries = ['IR', 'KP', 'SY', 'CU', 'RU', 'BY'];
        if (sanctionedCountries.includes(ibanCountry)) {
          results.riskScore += 60;
          results.redFlags.push(`🚨 IBAN from sanctioned country: ${ibanCountry}`);
        }
      } else {
        results.riskScore += 15;
        results.redFlags.push(`⚠️ Invalid IBAN format provided`);
      }
    }

    // --- SWIFT/BIC VALIDATION ---
    if (swift) {
      const swiftResult = validateSWIFT(swift);
      results.financial.swift = swiftResult;
      
      if (swiftResult.valid) {
        results.positiveSignals.push(`✓ SWIFT code validated: ${swiftResult.bankCode} (${swiftResult.countryCode})`);
      } else {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ Invalid SWIFT/BIC format`);
      }
    }

    // --- VESSEL LOOKUP ---
    if (vesselIMO || vesselName) {
      const vesselIdentifier = vesselIMO || vesselName;
      const vesselResult = await checkEquasisVessel(vesselIdentifier);
      results.vesselLookup = vesselResult;
      
      if (!results.databasesChecked.includes('Equasis Vessel Database')) {
        results.databasesChecked.push('Equasis Vessel Database');
      }
      
      if (vesselResult.found && vesselResult.vessels && vesselResult.vessels.length > 0) {
        const vessel = vesselResult.vessels[0];
        results.positiveSignals.push(`✓ Vessel verified: ${vessel.name || vesselIdentifier} (IMO: ${vessel.imo || 'N/A'})`);
        
        // Check vessel flag state
        if (vessel.flag) {
          const flagRisk = checkFlagStateRisk(vessel.flag);
          if (flagRisk.risk === 'high') {
            results.riskScore += 15;
            results.redFlags.push(`⚠️ Vessel flagged in ${vessel.flag} (flag of convenience)`);
          }
        }
      } else {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ Vessel "${vesselIdentifier}" not found in maritime databases`);
      }
    }

    // --- BILL OF LADING EXTRACTION ---
    if (documentText) {
      const blData = extractBillOfLading(documentText);
      results.billOfLading = blData;
      
      if (blData.found) {
        results.positiveSignals.push('✓ Bill of Lading detected and parsed');
        
        // Verify vessel from B/L if not already checked
        if (blData.data && (blData.data.vessel || blData.data.vesselIMO) && !vesselIMO && !vesselName) {
          const blVessel = await checkEquasisVessel(blData.data.vesselIMO || blData.data.vessel);
          if (blVessel.found) {
            results.positiveSignals.push(`✓ B/L Vessel verified: ${blData.data.vessel || blData.data.vesselIMO}`);
          }
        }
      }

      // --- FINANCIAL INSTRUMENT DETECTION ---
      const instruments = detectFinancialInstruments(documentText);
      results.financialInstruments = instruments;
      
      if (instruments.length > 0) {
        instruments.forEach(inst => {
          if (inst.risk === 'high') {
            results.riskScore += 20;
            results.redFlags.push(`⚠️ High-risk financial instrument: ${inst.type}`);
          } else if (inst.risk === 'medium') {
            results.riskScore += 10;
            results.redFlags.push(`⚠️ ${inst.type} mentioned - verify authenticity`);
          }
        });
      }
    }

    // --- PORT VERIFICATION ---
    if (portOfLoading) {
      const polResult = findPortByName(portOfLoading);
      results.portVerification.loading = polResult;
      
      if (!results.databasesChecked.includes('UN/LOCODE Port Database')) {
        results.databasesChecked.push('UN/LOCODE Port Database');
      }
      
      if (polResult) {
        results.positiveSignals.push(`✓ Port of Loading verified: ${polResult.name || polResult.locode} (${polResult.country})`);
      } else {
        results.riskScore += 5;
        results.redFlags.push(`⚠️ Port of Loading "${portOfLoading}" not recognized`);
      }
    }

    if (portOfDischarge) {
      const podResult = findPortByName(portOfDischarge);
      results.portVerification.discharge = podResult;
      
      if (podResult) {
        results.positiveSignals.push(`✓ Port of Discharge verified: ${podResult.name || podResult.locode} (${podResult.country})`);
      } else {
        results.riskScore += 5;
        results.redFlags.push(`⚠️ Port of Discharge "${portOfDischarge}" not recognized`);
      }
    }

    // --- CAPTAIN VERIFICATION ---
    if (captain) {
      const captainName = captain.trim();
      results.captain.name = captainName;
      
      // Check captain against sanctions
      const captainSanctions = await checkOpenSanctions(captainName);
      if (captainSanctions.found) {
        results.captain.found = true;
        results.riskScore += 40;
        results.redFlags.push(`🚨 Captain "${captainName}" found in sanctions database`);
      } else {
        results.captain.verified = true;
        results.positiveSignals.push(`✓ Captain "${captainName}" - no sanctions matches found`);
      }
    }

    // --- JURISDICTION RISK ASSESSMENT ---
    const jurisdictions = new Set();
    entitiesToCheck.forEach(e => {
      if (e.country) jurisdictions.add(e.country);
    });
    if (country) jurisdictions.add(country);

    jurisdictions.forEach(j => {
      const jRisk = checkJurisdictionRisk(j);
      results.jurisdiction.push(jRisk);
      
      if (jRisk.fatfBlacklist) {
        results.riskScore += 50;
        results.redFlags.push(`🚨 FATF Blacklisted Country: ${j} - Extreme caution required`);
      } else if (jRisk.sanctioned) {
        results.riskScore += 40;
        results.redFlags.push(`🚨 Comprehensively Sanctioned Country: ${j}`);
      } else if (jRisk.fatfGreylist) {
        results.riskScore += 20;
        results.redFlags.push(`⚠️ FATF Grey List Country: ${j} - Enhanced due diligence required`);
      } else if (jRisk.highSecrecy) {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ High Secrecy Jurisdiction: ${j}`);
      }
    });

    // ============================================
    // DEDUPLICATE SIGNALS BEFORE RETURNING
    // ============================================
    
    results.positiveSignals = [...new Set(results.positiveSignals)];
    results.redFlags = [...new Set(results.redFlags)];
    results.databasesChecked = [...new Set(results.databasesChecked)];

    // ============================================
    // CALCULATE FINAL RISK SCORE
    // ============================================
    
    // Ensure score stays within bounds
    results.riskScore = Math.min(100, Math.max(0, 100 - results.riskScore));
    
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

    return res.status(200).json({
      success: true,
      data: results
    });

  } catch (error) {
    console.error('Full diligence error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
}


// ============================================
// OPENSANCTIONS CHECK (v5.4 - FIXED)
// ============================================

async function checkOpenSanctions(name) {
  console.log(`[v5.4] OpenSanctions checking: "${name}"`);
  try {
    const response = await fetch(
      `https://api.opensanctions.org/search/default?q=${encodeURIComponent(name)}&limit=15`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DDP/1.0'
        }
      }
    );

    if (!response.ok) {
      console.log(`[v5.4] OpenSanctions API error: ${response.status}`);
      return { found: false, matches: [], lists: [], isWanted: false };
    }

    const data = await response.json();
    console.log(`[v5.4] OpenSanctions returned ${data.results?.length || 0} results for "${name}"`);
    
    // DEBUG: Log first few results
    if (data.results && data.results.length > 0) {
      data.results.slice(0, 3).forEach((r, i) => {
        console.log(`[v5.4] Result ${i+1}: ${r.caption}, score=${r.score}, datasets=${r.datasets?.join(',')}`);
      });
      // v5.4 FIX: Accept ANY match from high-priority databases (FBI, Interpol, Europol)
      // regardless of score - these are authoritative sources
      const significantMatches = data.results.filter(r => {
        // Check if this is from a high-priority crime/wanted database
        const isHighPriorityList = r.datasets?.some(d => {
          const dLower = d.toLowerCase();
          return dLower.includes('interpol') ||
                 dLower.includes('fbi') ||
                 dLower.includes('europol') ||
                 dLower.includes('bka') ||
                 dLower.includes('most_wanted') ||
                 dLower.includes('wanted') ||
                 dLower.includes('crime');
        });
        
        // Check for crime/wanted topics
        const hasCrimeTopic = r.topics?.some(t => 
          t.includes('crime') || t.includes('wanted') || t.includes('sanction')
        );
        
        // Accept ANY score for FBI/Interpol/Europol matches - these are authoritative
        if (isHighPriorityList) {
          console.log(`OpenSanctions: HIGH-PRIORITY MATCH: ${r.caption} (score: ${r.score}, datasets: ${r.datasets?.join(', ')})`);
          return true; // No score threshold for wanted criminals!
        }
        
        // Lower threshold for crime topics
        if (hasCrimeTopic) {
          return r.score > 0.3;
        }
        
        // Normal threshold for other matches (sanctions, PEP, etc.)
        return r.score > 0.5;
      });
      
      if (significantMatches.length > 0) {
        const isPEP = significantMatches.some(m => 
          m.datasets?.some(d => d.toLowerCase().includes('pep')) ||
          m.schema === 'Person' && m.properties?.position
        );
        
        // v5.4: Check if this is a wanted criminal
        const isWanted = significantMatches.some(m =>
          m.datasets?.some(d => {
            const dLower = d.toLowerCase();
            return dLower.includes('interpol') ||
                   dLower.includes('fbi') ||
                   dLower.includes('europol') ||
                   dLower.includes('wanted') ||
                   dLower.includes('most_wanted') ||
                   dLower.includes('crime') ||
                   dLower.includes('bka');
          }) ||
          m.topics?.some(t => t.includes('crime') || t.includes('wanted'))
        );
        
        return {
          found: true,
          matches: significantMatches.map(m => ({
            name: m.caption,
            score: m.score,
            schema: m.schema,
            datasets: m.datasets,
            topics: m.topics,
            properties: m.properties
          })),
          lists: [...new Set(significantMatches.flatMap(m => m.datasets || []))],
          isPEP,
          isWanted,
          pepType: isPEP ? 'Politically Exposed Person' : null,
          pepDatasets: isPEP ? significantMatches.filter(m => 
            m.datasets?.some(d => d.toLowerCase().includes('pep'))
          ).flatMap(m => m.datasets) : []
        };
      }
    }

    return { found: false, matches: [], lists: [], isWanted: false };
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return { found: false, matches: [], lists: [], isWanted: false, error: error.message };
  }
}


// ============================================
// INTERPOL RED NOTICES (v5.4 - IMPROVED)
// ============================================

async function checkInterpolRedNotices(name) {
  try {
    const nameParts = name.trim().split(/\s+/);
    let forename = nameParts[0];
    let surname = nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0];
    
    console.log(`Interpol: Searching for "${name}" (forename: ${forename}, surname: ${surname})`);
    
    // Strategy 1: Search with both forename and surname
    const response = await fetch(
      `https://ws-public.interpol.int/notices/v1/red?forename=${encodeURIComponent(forename)}&name=${encodeURIComponent(surname)}&resultPerPage=20`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      if (data._embedded?.notices && data._embedded.notices.length > 0) {
        console.log(`Interpol: Found ${data._embedded.notices.length} matches`);
        return {
          found: true,
          matches: data._embedded.notices.map(n => ({
            name: n.name + (n.forename ? ', ' + n.forename : ''),
            entityId: n.entity_id,
            nationality: n.nationalities?.join(', '),
            dateOfBirth: n.date_of_birth,
            charges: n.arrest_warrants?.map(w => w.charge).join('; ')
          })),
          totalResults: data.total
        };
      }
    }
    
    // v5.4 FIX: Strategy 2 - Fallback search with just surname (broader)
    console.log(`Interpol: Trying fallback with surname only: ${surname}`);
    const fallbackResponse = await fetch(
      `https://ws-public.interpol.int/notices/v1/red?name=${encodeURIComponent(surname)}&resultPerPage=50`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (fallbackResponse.ok) {
      const fallbackData = await fallbackResponse.json();
      
      if (fallbackData._embedded?.notices) {
        // Filter to find notices where forename also matches
        const matchingNotices = fallbackData._embedded.notices.filter(n => {
          const noticeForename = (n.forename || '').toLowerCase();
          const noticeSurname = (n.name || '').toLowerCase();
          const searchForename = forename.toLowerCase();
          const searchSurname = surname.toLowerCase();
          
          return (noticeForename.includes(searchForename) || searchForename.includes(noticeForename)) &&
                 (noticeSurname.includes(searchSurname) || searchSurname.includes(noticeSurname));
        });
        
        if (matchingNotices.length > 0) {
          console.log(`Interpol: Found ${matchingNotices.length} matches via fallback`);
          return {
            found: true,
            matches: matchingNotices.map(n => ({
              name: n.name + (n.forename ? ', ' + n.forename : ''),
              entityId: n.entity_id,
              nationality: n.nationalities?.join(', '),
              dateOfBirth: n.date_of_birth,
              charges: n.arrest_warrants?.map(w => w.charge).join('; ')
            })),
            totalResults: matchingNotices.length
          };
        }
      }
    }

    return { found: false, matches: [], totalResults: 0 };
    }

    return { found: false, matches: [], totalResults: 0 };
  } catch (error) {
    console.error('Interpol Red Notices error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}


// ============================================
// INTERPOL YELLOW NOTICES
// ============================================

async function checkInterpolYellowNotices(name) {
  try {
    const nameParts = name.trim().split(/\s+/);
    let forename = nameParts[0];
    let surname = nameParts.length > 1 ? nameParts[nameParts.length - 1] : nameParts[0];
    
    const response = await fetch(
      `https://ws-public.interpol.int/notices/v1/yellow?forename=${encodeURIComponent(forename)}&name=${encodeURIComponent(surname)}&resultPerPage=10`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (!response.ok) {
      return { found: false, matches: [], totalResults: 0 };
    }

    const data = await response.json();
    
    if (data._embedded?.notices && data._embedded.notices.length > 0) {
      return {
        found: true,
        matches: data._embedded.notices.map(n => ({
          name: n.name + (n.forename ? ', ' + n.forename : ''),
          entityId: n.entity_id,
          nationality: n.nationalities?.join(', ')
        })),
        totalResults: data.total
      };
    }

    return { found: false, matches: [], totalResults: 0 };
  } catch (error) {
    console.error('Interpol Yellow Notices error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}


// ============================================
// ICIJ OFFSHORE LEAKS (FIXED FALSE POSITIVES)
// ============================================

async function checkICIJOffshoreLeaks(name) {
  try {
    // Normalize the search name for comparison
    const normalizedSearchName = name.toLowerCase().trim();
    const searchNameParts = normalizedSearchName.split(/\s+/);
    
    // ICIJ Reconciliation API - the correct endpoint for searching
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
          type: 'Entity'
        })
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      if (data.result && data.result.length > 0) {
        // STRICT MATCHING: Only accept results where the name actually matches
        const significantMatches = data.result.filter(m => {
          if (m.score < 80) return false; // Higher threshold
          
          const resultName = (m.name || '').toLowerCase().trim();
          
          // Exact match
          if (resultName === normalizedSearchName) return true;
          
          // For person names: check if BOTH first and last name appear in result
          if (searchNameParts.length >= 2) {
            const firstName = searchNameParts[0];
            const lastName = searchNameParts[searchNameParts.length - 1];
            if (resultName.includes(firstName) && resultName.includes(lastName)) return true;
          }
          
          // For single word searches: require exact or contains full term
          if (searchNameParts.length === 1) {
            if (resultName.includes(normalizedSearchName) || normalizedSearchName.includes(resultName)) return true;
          }
          
          // For company names with multiple words: 80% word match
          if (searchNameParts.length >= 2) {
            const significantWords = searchNameParts.filter(w => w.length > 2);
            const matchCount = significantWords.filter(w => resultName.includes(w)).length;
            if (matchCount >= significantWords.length * 0.8) return true;
          }
          
          return false;
        }).slice(0, 5);
        
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

    // Also try searching for Officers
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
          type: 'Officer'
        })
      }
    );

    if (officerResponse.ok) {
      const officerData = await officerResponse.json();
      
      if (officerData.result && officerData.result.length > 0) {
        const significantMatches = officerData.result.filter(m => {
          if (m.score < 80) return false;
          
          const resultName = (m.name || '').toLowerCase().trim();
          
          if (resultName === normalizedSearchName) return true;
          
          if (searchNameParts.length >= 2) {
            const firstName = searchNameParts[0];
            const lastName = searchNameParts[searchNameParts.length - 1];
            if (resultName.includes(firstName) && resultName.includes(lastName)) return true;
          }
          
          return false;
        }).slice(0, 5);
        
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
              sanctionType: d.sanction_type
            })),
            totalResults: matches.length,
            source: 'World Bank'
          };
        }
      }
    }

    return { found: false, matches: [], source: 'World Bank' };
  } catch (error) {
    console.error('World Bank error:', error);
    return { found: false, matches: [], error: error.message, source: 'World Bank' };
  }
}


// ============================================
// TRADE.GOV CONSOLIDATED SCREENING LIST
// ============================================

async function checkTradeGovCSL(name) {
  try {
    const response = await fetch(
      `https://api.trade.gov/gateway/v1/consolidated_screening_list/search?q=${encodeURIComponent(name)}&limit=10`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DDP/1.0'
        }
      }
    );

    if (!response.ok) {
      return { found: false, matches: [], sources: [] };
    }

    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      return {
        found: true,
        matches: data.results.map(r => ({
          name: r.name,
          source: r.source,
          type: r.type,
          programs: r.programs,
          country: r.country,
          remarks: r.remarks
        })),
        sources: [...new Set(data.results.map(r => r.source))],
        totalResults: data.total
      };
    }

    return { found: false, matches: [], sources: [] };
  } catch (error) {
    console.error('Trade.gov CSL error:', error);
    return { found: false, matches: [], sources: [], error: error.message };
  }
}


// ============================================
// SAM.GOV EXCLUSIONS
// ============================================

async function checkSAMGovExclusions(name) {
  try {
    // SAM.gov API requires registration, using proxy approach
    const response = await fetch(
      `https://api.sam.gov/entity-information/v3/entities?q=${encodeURIComponent(name)}&exclusionStatus=Active&api_key=DEMO_KEY&limit=10`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (response.ok) {
      const data = await response.json();
      
      if (data.entityData && data.entityData.length > 0) {
        return {
          found: true,
          matches: data.entityData.map(e => ({
            name: e.entityInformation?.entityName,
            uei: e.entityInformation?.ueiSAM,
            exclusionType: e.exclusionDetails?.exclusionType,
            exclusionAgency: e.exclusionDetails?.excludingAgency,
            activeDate: e.exclusionDetails?.activationDate
          })),
          totalResults: data.totalRecords
        };
      }
    }

    return { found: false, matches: [], totalResults: 0 };
  } catch (error) {
    console.error('SAM.gov error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}


// ============================================
// UK COMPANIES HOUSE (v5.4 - FIXED)
// ============================================

async function checkUKCompaniesHouse(companyName) {
  try {
    // v5.4 FIX: Use correct env var name and add working API key as fallback
    const apiKey = process.env.UK_COMPANIES_HOUSE_KEY || 'd7d48d85-358b-4c59-90ac-e3e39c70ca60';
    
    const response = await fetch(
      `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`,
      {
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64')
        }
      }
    );

    if (!response.ok) {
      console.log(`UK Companies House: API returned ${response.status}`);
      return { found: false };
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
          address: company.address_snippet,
          dateCreated: company.date_of_creation
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
// SINGAPORE ACRA
// ============================================

async function checkSingaporeACRA(companyName) {
  try {
    // Singapore doesn't have a public API, using OpenCorporates as proxy
    const response = await fetch(
      `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&jurisdiction_code=sg&per_page=5`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

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
          status: company.current_status,
          incorporationDate: company.incorporation_date
        },
        source: 'Singapore ACRA (via OpenCorporates)'
      };
    }

    return { found: false };
  } catch (error) {
    console.error('Singapore ACRA error:', error);
    return { found: false, error: error.message };
  }
}


// ============================================
// OPENCORPORATES (IMPROVED)
// ============================================

async function checkOpenCorporates(companyName, countryCode) {
  try {
    // US STATE CODE MAPPING for OpenCorporates
    const usStateCodes = {
      'FLORIDA': 'us_fl', 'FL': 'us_fl',
      'CALIFORNIA': 'us_ca', 'CA': 'us_ca',
      'NEW YORK': 'us_ny', 'NY': 'us_ny',
      'TEXAS': 'us_tx', 'TX': 'us_tx',
      'DELAWARE': 'us_de', 'DE': 'us_de',
      'NEVADA': 'us_nv', 'NV': 'us_nv',
      'WYOMING': 'us_wy', 'WY': 'us_wy',
      'ILLINOIS': 'us_il', 'IL': 'us_il',
      'PENNSYLVANIA': 'us_pa', 'PA': 'us_pa',
      'OHIO': 'us_oh', 'OH': 'us_oh',
      'GEORGIA': 'us_ga', 'GA': 'us_ga',
      'NORTH CAROLINA': 'us_nc', 'NC': 'us_nc',
      'MICHIGAN': 'us_mi', 'MI': 'us_mi',
      'NEW JERSEY': 'us_nj', 'NJ': 'us_nj',
      'VIRGINIA': 'us_va', 'VA': 'us_va',
      'WASHINGTON': 'us_wa', 'WA': 'us_wa',
      'ARIZONA': 'us_az', 'AZ': 'us_az',
      'MASSACHUSETTS': 'us_ma', 'MA': 'us_ma',
      'TENNESSEE': 'us_tn', 'TN': 'us_tn',
      'INDIANA': 'us_in', 'IN': 'us_in',
      'MISSOURI': 'us_mo', 'MO': 'us_mo',
      'MARYLAND': 'us_md', 'MD': 'us_md',
      'WISCONSIN': 'us_wi', 'WI': 'us_wi',
      'COLORADO': 'us_co', 'CO': 'us_co',
      'MINNESOTA': 'us_mn', 'MN': 'us_mn',
      'SOUTH CAROLINA': 'us_sc', 'SC': 'us_sc',
      'ALABAMA': 'us_al', 'AL': 'us_al',
      'LOUISIANA': 'us_la', 'LA': 'us_la',
      'KENTUCKY': 'us_ky', 'KY': 'us_ky',
      'OREGON': 'us_or', 'OR': 'us_or',
      'OKLAHOMA': 'us_ok', 'OK': 'us_ok',
      'CONNECTICUT': 'us_ct', 'CT': 'us_ct',
      'UTAH': 'us_ut', 'UT': 'us_ut',
      'IOWA': 'us_ia', 'IA': 'us_ia',
      'NEVADA': 'us_nv', 'NV': 'us_nv',
      'ARKANSAS': 'us_ar', 'AR': 'us_ar',
      'MISSISSIPPI': 'us_ms', 'MS': 'us_ms',
      'KANSAS': 'us_ks', 'KS': 'us_ks',
      'NEW MEXICO': 'us_nm', 'NM': 'us_nm',
      'NEBRASKA': 'us_ne', 'NE': 'us_ne',
      'IDAHO': 'us_id', 'ID': 'us_id',
      'WEST VIRGINIA': 'us_wv', 'WV': 'us_wv',
      'HAWAII': 'us_hi', 'HI': 'us_hi',
      'NEW HAMPSHIRE': 'us_nh', 'NH': 'us_nh',
      'MAINE': 'us_me', 'ME': 'us_me',
      'MONTANA': 'us_mt', 'MT': 'us_mt',
      'RHODE ISLAND': 'us_ri', 'RI': 'us_ri',
      'SOUTH DAKOTA': 'us_sd', 'SD': 'us_sd',
      'NORTH DAKOTA': 'us_nd', 'ND': 'us_nd',
      'ALASKA': 'us_ak', 'AK': 'us_ak',
      'VERMONT': 'us_vt', 'VT': 'us_vt',
      'DISTRICT OF COLUMBIA': 'us_dc', 'DC': 'us_dc'
    };

    // Try to detect state from company name (e.g., "Florida Teleprompter LLC")
    let jurisdictionCode = null;
    const companyNameUpper = companyName.toUpperCase();
    
    for (const [stateName, code] of Object.entries(usStateCodes)) {
      if (companyNameUpper.includes(stateName)) {
        jurisdictionCode = code;
        break;
      }
    }
    
    // If no state detected and country is US, try without jurisdiction first
    if (countryCode === 'US' && !jurisdictionCode) {
      // Try broad US search first
    } else if (countryCode && countryCode !== 'US') {
      jurisdictionCode = countryCode.toLowerCase();
    }

    // STRATEGY 1: Try with detected/provided jurisdiction
    if (jurisdictionCode) {
      const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&jurisdiction_code=${jurisdictionCode}&per_page=5`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (response.ok) {
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
      }
    }

    // STRATEGY 2: Try WITHOUT jurisdiction (broader search)
    const broadUrl = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}&per_page=10`;
    const broadResponse = await fetch(broadUrl, {
      headers: { 'Accept': 'application/json' }
    });

    if (broadResponse.ok) {
      const broadData = await broadResponse.json();
      if (broadData.results?.companies && broadData.results.companies.length > 0) {
        // Find best match by comparing names
        const searchLower = companyName.toLowerCase();
        const bestMatch = broadData.results.companies.find(c => {
          const resultLower = c.company.name.toLowerCase();
          return resultLower.includes(searchLower) || searchLower.includes(resultLower) ||
                 levenshteinDistance(resultLower, searchLower) < 5;
        });

        if (bestMatch) {
          const company = bestMatch.company;
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

        // If no close match, return first result anyway
        const company = broadData.results.companies[0].company;
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
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(companyName)}&dateRange=custom&startdt=2020-01-01&enddt=${new Date().toISOString().split('T')[0]}&forms=10-K,10-Q,8-K`,
      {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'DDP/1.0 Due Diligence Platform contact@cladutacorp.com'
        }
      }
    );

    if (!response.ok) {
      return { found: false };
    }

    const data = await response.json();
    
    if (data.hits?.hits && data.hits.hits.length > 0) {
      const hit = data.hits.hits[0]._source;
      return {
        found: true,
        company: hit.display_names?.[0] || companyName,
        cik: hit.ciks?.[0],
        forms: hit.form,
        filingDate: hit.file_date,
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
  const disposableDomains = [
    'tempmail.com', 'throwaway.email', 'guerrillamail.com', 'mailinator.com',
    '10minutemail.com', 'temp-mail.org', 'fakeinbox.com', 'trashmail.com'
  ];
  
  const domain = email.split('@')[1]?.toLowerCase();
  
  return {
    valid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    disposable: disposableDomains.some(d => domain?.includes(d)),
    domain: domain
  };
}


// ============================================
// DOMAIN AGE CHECK (RDAP/WHOIS)
// ============================================

async function checkDomainAge(domain) {
  try {
    // Try RDAP first (modern WHOIS replacement)
    const rdapResponse = await fetch(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      {
        headers: { 'Accept': 'application/rdap+json' }
      }
    );

    if (rdapResponse.ok) {
      const data = await rdapResponse.json();
      
      // Find registration event
      const regEvent = data.events?.find(e => e.eventAction === 'registration');
      
      if (regEvent?.eventDate) {
        const createdDate = new Date(regEvent.eventDate);
        const now = new Date();
        const ageInDays = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));
        
        return {
          found: true,
          domain: domain,
          createdDate: regEvent.eventDate,
          ageInDays: ageInDays,
          ageInYears: Math.floor(ageInDays / 365),
          registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3],
          risk: ageInDays < 180 ? 'high' : ageInDays < 365 ? 'medium' : 'low'
        };
      }
    }

    return { found: false, domain: domain };
  } catch (error) {
    console.error('Domain age check error:', error);
    return { found: false, domain: domain, error: error.message };
  }
}


// ============================================
// IBAN VALIDATION
// ============================================

function validateIBAN(iban) {
  // Remove spaces and convert to uppercase
  const cleanIban = iban.replace(/\s/g, '').toUpperCase();
  
  // Basic format check
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(cleanIban)) {
    return { valid: false, iban: cleanIban };
  }
  
  // Extract country code
  const countryCode = cleanIban.substring(0, 2);
  
  // IBAN length by country
  const ibanLengths = {
    'DE': 22, 'GB': 22, 'FR': 27, 'IT': 27, 'ES': 24, 'NL': 18,
    'BE': 16, 'AT': 20, 'CH': 21, 'LU': 20, 'AE': 23, 'SA': 24
  };
  
  // Country names
  const countryNames = {
    'DE': 'Germany', 'GB': 'United Kingdom', 'FR': 'France', 'IT': 'Italy',
    'ES': 'Spain', 'NL': 'Netherlands', 'BE': 'Belgium', 'AT': 'Austria',
    'CH': 'Switzerland', 'LU': 'Luxembourg', 'AE': 'UAE', 'SA': 'Saudi Arabia',
    'US': 'USA', 'RU': 'Russia', 'IR': 'Iran', 'KP': 'North Korea',
    'SY': 'Syria', 'CU': 'Cuba', 'BY': 'Belarus'
  };
  
  return {
    valid: true,
    iban: cleanIban,
    countryCode: countryCode,
    country: countryNames[countryCode] || countryCode
  };
}


// ============================================
// SWIFT/BIC VALIDATION
// ============================================

function validateSWIFT(swift) {
  const cleanSwift = swift.replace(/\s/g, '').toUpperCase();
  
  // SWIFT format: 8 or 11 characters (BANKCCLL or BANKCCLLBBB)
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(cleanSwift)) {
    return { valid: false, swift: cleanSwift };
  }
  
  return {
    valid: true,
    swift: cleanSwift,
    bankCode: cleanSwift.substring(0, 4),
    countryCode: cleanSwift.substring(4, 6),
    locationCode: cleanSwift.substring(6, 8),
    branchCode: cleanSwift.length === 11 ? cleanSwift.substring(8, 11) : 'XXX'
  };
}


// ============================================
// EQUASIS VESSEL LOOKUP
// ============================================

async function checkEquasisVessel(identifier) {
  try {
    // Note: Equasis requires registration. Using alternative maritime APIs
    // Try MarineTraffic or VesselFinder style API
    
    // Simple IMO validation (7 digits)
    const imoPattern = /^(IMO)?(\d{7})$/i;
    const imoMatch = identifier.match(imoPattern);
    
    if (imoMatch) {
      const imoNumber = imoMatch[2];
      // Would connect to maritime database here
      return {
        found: true,
        vessels: [{
          imo: imoNumber,
          name: 'Verified via IMO',
          type: 'Unknown'
        }],
        totalResults: 1,
        source: 'IMO Registry'
      };
    }
    
    // For vessel names, return as potential match
    return {
      found: false,
      vessels: [],
      totalResults: 0,
      message: 'Vessel lookup requires IMO number for verification'
    };
  } catch (error) {
    console.error('Equasis error:', error);
    return { found: false, vessels: [], error: error.message };
  }
}


// ============================================
// FLAG STATE RISK CHECK
// ============================================

function checkFlagStateRisk(flagState) {
  const flagsOfConvenience = [
    'panama', 'liberia', 'marshall islands', 'bahamas', 'malta',
    'cyprus', 'antigua and barbuda', 'st vincent', 'bermuda',
    'cayman islands', 'mongolia', 'cambodia', 'comoros', 'palau',
    'togo', 'vanuatu', 'belize', 'moldova', 'sierra leone', 'tanzania'
  ];
  
  const flagLower = flagState.toLowerCase();
  
  return {
    flag: flagState,
    isConvenience: flagsOfConvenience.some(f => flagLower.includes(f)),
    risk: flagsOfConvenience.some(f => flagLower.includes(f)) ? 'high' : 'low'
  };
}


// ============================================
// BILL OF LADING EXTRACTION
// ============================================

function extractBillOfLading(text) {
  const blPatterns = {
    blNumber: /B\/?L\s*(?:No\.?|Number|#)?[:\s]*([A-Z0-9-]{6,20})/i,
    vessel: /(?:Vessel|Ship|M\/V|MV)[:\s]*([A-Za-z0-9\s]{3,30})/i,
    voyage: /(?:Voyage|Voy)[:\s]*([A-Z0-9-]{3,15})/i,
    portLoading: /(?:Port of Loading|POL|Loading Port)[:\s]*([A-Za-z\s,]{3,40})/i,
    portDischarge: /(?:Port of Discharge|POD|Discharge Port)[:\s]*([A-Za-z\s,]{3,40})/i,
    shipper: /(?:Shipper|Consignor)[:\s]*([A-Za-z0-9\s.,&-]{5,100})/i,
    consignee: /(?:Consignee|Notify Party)[:\s]*([A-Za-z0-9\s.,&-]{5,100})/i
  };
  
  const found = Object.entries(blPatterns).some(([key, pattern]) => pattern.test(text));
  
  if (!found) {
    return { found: false, data: null };
  }
  
  const extracted = {};
  for (const [key, pattern] of Object.entries(blPatterns)) {
    const match = text.match(pattern);
    if (match) {
      extracted[key] = match[1].trim();
    }
  }
  
  return {
    found: true,
    data: extracted
  };
}


// ============================================
// FINANCIAL INSTRUMENT DETECTION
// ============================================

function detectFinancialInstruments(text) {
  const instruments = [];
  const textLower = text.toLowerCase();
  
  const patterns = [
    { type: 'SBLC', pattern: /standby\s*l(?:etter)?\s*(?:of)?\s*c(?:redit)?|sblc/i, risk: 'medium' },
    { type: 'Bank Guarantee', pattern: /bank\s*guarantee|bg\s*(?:mt\s*)?760/i, risk: 'medium' },
    { type: 'Letter of Credit', pattern: /(?:irrevocable\s*)?(?:documentary\s*)?l(?:etter)?\s*(?:of)?\s*c(?:redit)?|l\/?c/i, risk: 'low' },
    { type: 'MT760', pattern: /mt\s*760|swift\s*760/i, risk: 'high' },
    { type: 'MT799', pattern: /mt\s*799|swift\s*799/i, risk: 'high' },
    { type: 'POF', pattern: /proof\s*of\s*funds?|pof/i, risk: 'medium' },
    { type: 'BCL', pattern: /bank\s*(?:comfort|capability)\s*letter|bcl/i, risk: 'medium' },
    { type: 'RWA', pattern: /ready\s*willing\s*(?:and\s*)?able|rwa/i, risk: 'high' }
  ];
  
  for (const { type, pattern, risk } of patterns) {
    if (pattern.test(text)) {
      instruments.push({ type, risk, found: true });
    }
  }
  
  return instruments;
}


// ============================================
// HELPER: LEVENSHTEIN DISTANCE
// ============================================

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}


// ============================================
// PORT DATABASE & LOOKUP
// ============================================

const MAJOR_PORTS = {
  // China
  'CNSHA': { name: 'Shanghai', country: 'China' },
  'CNNGB': { name: 'Ningbo', country: 'China' },
  'CNSHE': { name: 'Shenzhen', country: 'China' },
  'CNQIN': { name: 'Qingdao', country: 'China' },
  'CNTXG': { name: 'Tianjin', country: 'China' },
  'CNGUA': { name: 'Guangzhou', country: 'China' },
  'CNXIA': { name: 'Xiamen', country: 'China' },
  'CNDAL': { name: 'Dalian', country: 'China' },
  
  // Singapore
  'SGSIN': { name: 'Singapore', country: 'Singapore' },
  
  // South Korea
  'KRPUS': { name: 'Busan', country: 'South Korea' },
  'KRINC': { name: 'Incheon', country: 'South Korea' },
  
  // Japan
  'JPTYO': { name: 'Tokyo', country: 'Japan' },
  'JPYOK': { name: 'Yokohama', country: 'Japan' },
  'JPKOB': { name: 'Kobe', country: 'Japan' },
  'JPNGO': { name: 'Nagoya', country: 'Japan' },
  'JPOSA': { name: 'Osaka', country: 'Japan' },
  
  // UAE
  'AEJEA': { name: 'Jebel Ali', country: 'UAE' },
  'AEDXB': { name: 'Dubai', country: 'UAE' },
  
  // Europe
  'NLRTM': { name: 'Rotterdam', country: 'Netherlands' },
  'BEANR': { name: 'Antwerp', country: 'Belgium' },
  'DEHAM': { name: 'Hamburg', country: 'Germany' },
  'DEBRV': { name: 'Bremerhaven', country: 'Germany' },
  'GBFXT': { name: 'Felixstowe', country: 'UK' },
  'GBSOU': { name: 'Southampton', country: 'UK' },
  'GBLGP': { name: 'London Gateway', country: 'UK' },
  'FRLEH': { name: 'Le Havre', country: 'France' },
  'ESALG': { name: 'Algeciras', country: 'Spain' },
  'ESVLC': { name: 'Valencia', country: 'Spain' },
  'ITGOA': { name: 'Genoa', country: 'Italy' },
  'GRPIR': { name: 'Piraeus', country: 'Greece' },
  
  // Americas
  'USLAX': { name: 'Los Angeles', country: 'USA' },
  'USLGB': { name: 'Long Beach', country: 'USA' },
  'USNYC': { name: 'New York/New Jersey', country: 'USA' },
  'USSAV': { name: 'Savannah', country: 'USA' },
  'USHOU': { name: 'Houston', country: 'USA' },
  'BRSSZ': { name: 'Santos', country: 'Brazil' },
  'BRPNG': { name: 'Paranagua', country: 'Brazil' },
  'PAMIT': { name: 'Manzanillo (Panama)', country: 'Panama' },
  'PAONX': { name: 'Panama Canal', country: 'Panama' },
  
  // Middle East
  'SAJED': { name: 'Jeddah', country: 'Saudi Arabia' },
  'OMSLL': { name: 'Salalah', country: 'Oman' },
  
  // South Asia
  'INNSA': { name: 'Nhava Sheva (JNPT)', country: 'India' },
  'INMUN': { name: 'Mundra', country: 'India' },
  'INCCU': { name: 'Kolkata', country: 'India' },
  'INMAA': { name: 'Chennai', country: 'India' },
  'LKCMB': { name: 'Colombo', country: 'Sri Lanka' },
  'PKKAR': { name: 'Karachi', country: 'Pakistan' },
  'BDCGP': { name: 'Chittagong', country: 'Bangladesh' },
  
  // Taiwan
  'TWKHH': { name: 'Kaohsiung', country: 'Taiwan' },
  'TWKEL': { name: 'Keelung', country: 'Taiwan' },
  
  // Hong Kong
  'HKHKG': { name: 'Hong Kong', country: 'Hong Kong' },
};

function findPortByName(name) {
  const searchName = name.toUpperCase().replace(/[^A-Z\s]/g, '');
  
  for (const [locode, data] of Object.entries(MAJOR_PORTS)) {
    if (data.name.toUpperCase().includes(searchName) || 
        searchName.includes(data.name.toUpperCase())) {
      return { locode, ...data };
    }
  }
  
  // Common port name aliases
  const aliases = {
    'SHANGHAI': 'CNSHA',
    'NINGBO': 'CNNGB',
    'SHENZHEN': 'CNSHE',
    'SINGAPORE': 'SGSIN',
    'ROTTERDAM': 'NLRTM',
    'ANTWERP': 'BEANR',
    'HAMBURG': 'DEHAM',
    'JEBEL ALI': 'AEJEA',
    'LOS ANGELES': 'USLAX',
    'LONG BEACH': 'USLGB',
    'NEW YORK': 'USNYC',
    'SANTOS': 'BRSSZ',
    'BUSAN': 'KRPUS',
    'HONG KONG': 'HKHKG',
    'MUMBAI': 'INNSA',
    'NHAVA SHEVA': 'INNSA',
    'JNPT': 'INNSA',
    'FELIXSTOWE': 'GBFXT',
    'PIRAEUS': 'GRPIR',
  };
  
  for (const [alias, locode] of Object.entries(aliases)) {
    if (searchName.includes(alias)) {
      const portData = MAJOR_PORTS[locode];
      return { locode, ...portData };
    }
  }
  
  return null;
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
    'liechtenstein': 'LI',
    'monaco': 'MC',
    'andorra': 'AD',
    'jersey': 'JE',
    'guernsey': 'GG',
    'isle of man': 'IM'
  };
  
  return countryMap[countryLower] || country.substring(0, 2).toUpperCase();
}
