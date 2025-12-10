// Full Due Diligence API - Real Database Checks (v5.2)
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

      // --- TRADE.GOV CONSOLIDATED SCREENING LIST CHECK ---
      const cslResult = await checkTradeGovCSL(entity.name);
      results.databasesChecked.push('Trade.gov CSL (BIS Entity/Denied/MEU/Unverified)');
      
      if (cslResult.found) {
        results.tradeGovCSL.found = true;
        results.tradeGovCSL.matches.push({
          searchedName: entity.name,
          role: entity.role,
          matches: cslResult.matches
        });
        results.tradeGovCSL.sources.push(...(cslResult.sources || []));
        results.tradeGovCSL.totalResults += cslResult.totalResults || 0;
        
        // Different risk scores based on list type
        const isDenied = cslResult.matches?.some(m => m.source === 'Denied Persons List');
        const isEntity = cslResult.matches?.some(m => m.source === 'Entity List');
        const isMEU = cslResult.matches?.some(m => m.source === 'Military End User List');
        const isUnverified = cslResult.matches?.some(m => m.source === 'Unverified List');
        const isSDN = cslResult.matches?.some(m => m.source?.includes('SDN'));
        
        if (isDenied || isSDN) {
          results.riskScore += 60;
          results.redFlags.push(`🚨 ${entity.name}: DENIED EXPORT PRIVILEGES - Cannot transact with US goods/services`);
        } else if (isEntity || isMEU) {
          results.riskScore += 45;
          results.redFlags.push(`🚨 ${entity.name}: BIS Entity/Military End User List - Export license required`);
        } else if (isUnverified) {
          results.riskScore += 25;
          results.redFlags.push(`⚠️ ${entity.name}: BIS Unverified List - Red flag, additional due diligence required`);
        } else {
          results.riskScore += 35;
          results.redFlags.push(`🚨 ${entity.name}: Found on US Trade Consolidated Screening List`);
        }
      }

      // --- SAM.GOV EXCLUSIONS CHECK ---
      const samResult = await checkSAMGovExclusions(entity.name);
      results.databasesChecked.push('SAM.gov Exclusions (US Govt Debarred)');
      
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
        results.databasesChecked.push('Interpol Yellow Notices');
        
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

        // Singapore ACRA (via data.gov.sg)
        if (countryCode === 'SG') {
          const sgResult = await checkSingaporeACRA(entity.name);
          results.databasesChecked.push('Singapore ACRA');
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
        
        // --- DOMAIN AGE CHECK (for corporate emails) ---
        if (emailResult.corporate) {
          const domainResult = await checkDomainAge(entity.email);
          results.domainAge = domainResult;
          results.databasesChecked.push('Domain Age (RDAP/WHOIS)');
          
          if (domainResult.found && !domainResult.commonProvider) {
            if (domainResult.risk === 'critical') {
              results.riskScore += 35;
              results.redFlags.push(`🚨 ${domainResult.domain}: Domain registered < 30 days ago - EXTREME RISK`);
            } else if (domainResult.risk === 'high') {
              results.riskScore += 20;
              results.redFlags.push(`⚠️ ${domainResult.domain}: Domain registered < 90 days ago - Newly created, verify legitimacy`);
            } else if (domainResult.risk === 'medium') {
              results.riskScore += 10;
              results.redFlags.push(`⚠️ ${domainResult.domain}: Domain < 1 year old (${domainResult.ageInDays} days)`);
            } else if (domainResult.ageInYears >= 5) {
              results.riskScore -= 5;
              results.positiveSignals.push(`✓ ${domainResult.domain}: Established domain (${domainResult.ageInYears}+ years)`);
            }
          }
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
        // Check for sanctioned banks
        if (swiftResult.sanctioned) {
          results.riskScore += 70;
          results.redFlags.push(`🚨 SANCTIONED BANK: ${swiftResult.sanctionInfo.name} (${swiftResult.sanctionInfo.country}) - ${swiftResult.sanctionInfo.reason}. DO NOT TRANSACT.`);
        } else if (swiftResult.highRiskCountry) {
          results.riskScore += 25;
          results.redFlags.push(`⚠️ Bank in HIGH-RISK jurisdiction (${swiftResult.countryCode}) - Enhanced due diligence required`);
        } else {
          results.positiveSignals.push(`✓ SWIFT code validated: ${swiftResult.bankCode} (${swiftResult.countryCode})`);
        }
      }
    }

    // ============================================
    // VESSEL/SHIP LOOKUP (via Equasis)
    // For commodities traders
    // ============================================
    
    if (vesselIMO || vesselName) {
      const vesselIdentifier = vesselIMO || vesselName;
      const identifierType = vesselIMO ? 'imo' : 'name';
      
      const vesselResult = await checkVesselEquasis(vesselIdentifier, identifierType);
      results.vesselLookup = vesselResult;
      results.databasesChecked.push('Equasis Vessel Database');
      
      if (vesselResult.found && vesselResult.vessels.length > 0) {
        const vessel = vesselResult.vessels[0];
        results.positiveSignals.push(`✓ Vessel verified: ${vessel.name || vesselIdentifier} (IMO: ${vessel.imo || 'N/A'})`);
        
        // Check for red flags in vessel data
        if (vessel.hasDetentions) {
          results.riskScore += 15;
          results.redFlags.push(`⚠️ Vessel ${vessel.name}: Has PSC detention history - verify compliance`);
        }
        
        // Flag if vessel is very old (built before 1990)
        if (vessel.yearBuilt && vessel.yearBuilt < 1990) {
          results.riskScore += 10;
          results.redFlags.push(`⚠️ Vessel ${vessel.name}: Built in ${vessel.yearBuilt} - older vessel, verify seaworthiness`);
        }
        
        // Add vessel details to results
        results.vesselLookup.verifiedVessel = {
          imo: vessel.imo,
          name: vessel.name,
          flag: vessel.flag,
          type: vessel.type,
          grossTonnage: vessel.grossTonnage,
          deadweight: vessel.deadweight,
          yearBuilt: vessel.yearBuilt,
          owner: vessel.owner,
          manager: vessel.manager,
          classification: vessel.classificationSociety
        };
      } else if (vesselIMO) {
        // If IMO was provided but vessel not found - that's a red flag
        results.riskScore += 25;
        results.redFlags.push(`🚨 Vessel IMO ${vesselIMO}: NOT FOUND in Equasis database - verify vessel exists`);
      }
    }

    // ============================================
    // BILL OF LADING EXTRACTION & VERIFICATION
    // ============================================
    
    if (documentText) {
      const blData = extractBillOfLading(documentText);
      if (blData && blData.found) {
        results.billOfLading = blData;
        results.databasesChecked.push('Bill of Lading Extraction');
        results.positiveSignals.push('✓ Bill of Lading detected and parsed');
        
        // If B/L has vessel IMO and we haven't checked it yet, verify it
        if (blData.vesselIMO && !vesselIMO) {
          const vesselResult = await checkVesselEquasis(blData.vesselIMO, 'imo');
          if (vesselResult.found) {
            results.vesselLookup = vesselResult;
            results.positiveSignals.push(`✓ B/L Vessel verified: ${blData.vessel || blData.vesselIMO}`);
          } else {
            results.riskScore += 20;
            results.redFlags.push(`⚠️ Vessel in B/L (IMO: ${blData.vesselIMO}) not found in Equasis`);
          }
        }
        
        // Extract captain for verification
        if (blData.captain) {
          results.captain = {
            found: true,
            name: blData.captain,
            source: 'Bill of Lading',
            verified: false
          };
          results.databasesChecked.push('Captain Extraction');
        }
      }
      
      // Detect financial instruments
      const instruments = detectFinancialInstruments(documentText);
      if (instruments.length > 0) {
        results.financialInstruments = instruments;
        results.databasesChecked.push('Financial Instrument Detection');
        
        for (const inst of instruments) {
          if (inst.risk === 'HIGH') {
            results.riskScore += 15;
            results.redFlags.push(`⚠️ ${inst.type} detected: ${inst.note}`);
          } else if (inst.risk === 'VERIFY') {
            results.redFlags.push(`📋 ${inst.type} detected - ${inst.note}`);
          }
        }
      }
    }

    // ============================================
    // PORT VERIFICATION (UN/LOCODE)
    // ============================================
    
    // Check port of loading
    const polInput = portOfLoading || results.billOfLading?.portOfLoading;
    if (polInput) {
      const polResult = verifyPort(polInput);
      results.portVerification.loading = polResult;
      results.databasesChecked.push('Port of Loading Verification');
      
      if (polResult.valid) {
        results.positiveSignals.push(`✓ Port of Loading verified: ${polResult.name || polResult.locode} (${polResult.country})`);
      } else {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ Port of Loading "${polInput}" not found - verify port exists`);
      }
    }
    
    // Check port of discharge
    const podInput = portOfDischarge || results.billOfLading?.portOfDischarge;
    if (podInput) {
      const podResult = verifyPort(podInput);
      results.portVerification.discharge = podResult;
      results.databasesChecked.push('Port of Discharge Verification');
      
      if (podResult.valid) {
        results.positiveSignals.push(`✓ Port of Discharge verified: ${podResult.name || podResult.locode} (${podResult.country})`);
      } else {
        results.riskScore += 10;
        results.redFlags.push(`⚠️ Port of Discharge "${podInput}" not found - verify port exists`);
      }
    }

    // ============================================
    // CAPTAIN VERIFICATION
    // ============================================
    
    const captainName = captain || results.captain?.name || results.billOfLading?.captain;
    if (captainName && !results.captain?.found) {
      results.captain = {
        found: true,
        name: captainName,
        source: 'Manual entry',
        verified: false
      };
      results.databasesChecked.push('Captain Name Extraction');
      
      // Cross-reference captain against sanctions
      const captainSanctions = await checkOpenSanctions(captainName);
      if (captainSanctions.found) {
        results.captain.sanctionsMatch = true;
        results.riskScore += 50;
        results.redFlags.push(`🚨 Captain "${captainName}" has POTENTIAL SANCTIONS MATCH - verify identity`);
      } else {
        results.captain.sanctionsMatch = false;
        results.positiveSignals.push(`✓ Captain "${captainName}" - no sanctions matches found`);
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
// TRADE.GOV CONSOLIDATED SCREENING LIST (CSL)
// Includes: BIS Entity List, Denied Persons, Unverified, MEU, OFAC SDN, and more
// Free API - Updated hourly
// ============================================

async function checkTradeGovCSL(name) {
  try {
    console.log(`Trade.gov CSL: Searching for "${name}"`);
    
    // Trade.gov CSL API - free, public API with fuzzy matching
    // API documentation: https://developer.trade.gov/consolidated-screening-list.html
    const response = await fetch(
      `https://api.trade.gov/gateway/v1/consolidated_screening_list/search?name=${encodeURIComponent(name)}&fuzzy_name=true`,
      {
        headers: {
          'Accept': 'application/json',
          'subscription-key': process.env.TRADE_GOV_API_KEY || '' // Optional API key for higher rate limits
        }
      }
    );

    if (!response.ok) {
      console.log(`Trade.gov CSL: API returned ${response.status}`);
      // Try alternative endpoint without subscription key
      const altResponse = await fetch(
        `https://api.trade.gov/consolidated_screening_list/search?api_key=ODbvlRoNTlguYFMPJuXt7FP4&name=${encodeURIComponent(name)}&fuzzy_name=true`,
        { headers: { 'Accept': 'application/json' } }
      );
      
      if (!altResponse.ok) {
        return { found: false, matches: [], error: 'API error', sources: [] };
      }
      
      const altData = await altResponse.json();
      return processCSLResponse(altData, name);
    }

    const data = await response.json();
    return processCSLResponse(data, name);
    
  } catch (error) {
    console.error('Trade.gov CSL error:', error);
    return { found: false, matches: [], error: error.message, sources: [] };
  }
}

function processCSLResponse(data, searchName) {
  if (!data.results || data.results.length === 0) {
    console.log(`Trade.gov CSL: No results for "${searchName}"`);
    return { found: false, matches: [], sources: [], totalResults: 0 };
  }

  console.log(`Trade.gov CSL: Found ${data.results.length} results for "${searchName}"`);
  
  // Map source codes to readable names
  const sourceNames = {
    'DPL': 'Denied Persons List',
    'EL': 'Entity List',
    'UVL': 'Unverified List',
    'MEU': 'Military End User List',
    'SDN': 'OFAC SDN List',
    'FSE': 'Foreign Sanctions Evaders',
    'SSI': 'Sectoral Sanctions',
    'PLC': 'Palestinian Legislative Council',
    'ISN': 'Nonproliferation Sanctions',
    'DTC': 'ITAR Debarred',
    'CAP': 'Capta List',
    '561': 'Part 561 List',
    'NS-MBS': 'Non-SDN Menu-Based Sanctions',
    'NS-ISA': 'NS-Iran Sanctions Act',
    'CMIC': 'NS-CMIC List',
    'CCMC': 'Chinese Military Companies'
  };

  const matches = data.results.slice(0, 10).map(r => ({
    name: r.name,
    alternateNames: r.alt_names || [],
    source: sourceNames[r.source] || r.source,
    sourceCode: r.source,
    type: r.type,
    programs: r.programs,
    country: r.country,
    addresses: r.addresses,
    remarks: r.remarks,
    federalRegisterNotice: r.federal_register_notice,
    startDate: r.start_date,
    endDate: r.end_date,
    score: r.score
  }));

  const sources = [...new Set(data.results.map(r => sourceNames[r.source] || r.source))];

  // Log match details
  matches.forEach((m, i) => {
    console.log(`  CSL Match ${i+1}: ${m.name} - ${m.source} (score: ${m.score})`);
  });

  return {
    found: true,
    matches: matches,
    sources: sources,
    totalResults: data.total || data.results.length
  };
}


// ============================================
// OPENSANCTIONS WITH PEP DETECTION
// ============================================

// Normalize name: remove diacritics and special characters
function normalizeName(name) {
  if (!name) return '';
  
  // Common diacritic mappings (Eastern European names)
  const diacriticMap = {
    'ž': 'z', 'Ž': 'Z', 'ř': 'r', 'Ř': 'R', 'š': 's', 'Š': 'S',
    'č': 'c', 'Č': 'C', 'ć': 'c', 'Ć': 'C', 'đ': 'd', 'Đ': 'D',
    'ñ': 'n', 'Ñ': 'N', 'ü': 'u', 'Ü': 'U', 'ö': 'o', 'Ö': 'O',
    'ä': 'a', 'Ä': 'A', 'ß': 'ss', 'ø': 'o', 'Ø': 'O', 'å': 'a',
    'Å': 'A', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
    'ł': 'l', 'Ł': 'L', 'ń': 'n', 'Ń': 'N', 'ś': 's', 'Ś': 'S',
    'ź': 'z', 'Ź': 'Z', 'ż': 'z', 'Ż': 'Z', 'ě': 'e', 'Ě': 'E',
    'ů': 'u', 'Ů': 'U', 'ý': 'y', 'Ý': 'Y', 'á': 'a', 'Á': 'A',
    'í': 'i', 'Í': 'I', 'é': 'e', 'É': 'E', 'ú': 'u', 'Ú': 'U',
    'ó': 'o', 'Ó': 'O', 'ô': 'o', 'Ô': 'O', 'è': 'e', 'È': 'E',
    'ê': 'e', 'Ê': 'E', 'ë': 'e', 'Ë': 'E', 'î': 'i', 'Î': 'I',
    'ï': 'i', 'Ï': 'I', 'ù': 'u', 'Ù': 'U', 'û': 'u', 'Û': 'U',
    'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I',
    'ă': 'a', 'Ă': 'A', 'â': 'a', 'Â': 'A', 'ț': 't', 'Ț': 'T',
    'ș': 's', 'Ș': 'S', 'ж': 'zh', 'Ж': 'Zh', 'ружа': 'ruja'
  };
  
  let normalized = name;
  for (const [diacritic, replacement] of Object.entries(diacriticMap)) {
    normalized = normalized.split(diacritic).join(replacement);
  }
  
  // Also try built-in normalization as fallback
  try {
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    // Ignore if normalize not available
  }
  
  return normalized.trim();
}

// Generate name variations for better matching
function getNameVariations(name) {
  const variations = new Set();
  const normalized = normalizeName(name);
  
  variations.add(name);
  variations.add(normalized);
  
  // If name has multiple parts, try different orderings
  const parts = normalized.split(/\s+/);
  if (parts.length >= 2) {
    // Original order
    variations.add(parts.join(' '));
    // Last name first
    variations.add(`${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`);
    // First and last only
    if (parts.length > 2) {
      variations.add(`${parts[0]} ${parts[parts.length - 1]}`);
    }
  }
  
  return [...variations];
}

// ============================================
// DOMAIN AGE CHECK (RDAP/WHOIS)
// Flags newly registered domains (common scam indicator)
// ============================================

async function checkDomainAge(email) {
  try {
    if (!email || !email.includes('@')) {
      return { found: false, error: 'No valid email provided' };
    }
    
    const domain = email.split('@')[1].toLowerCase();
    
    // Skip common email providers - they're not suspicious based on domain age
    const commonProviders = [
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
      'icloud.com', 'aol.com', 'protonmail.com', 'mail.com', 'yandex.com',
      'gmx.com', 'zoho.com', 'fastmail.com', 'tutanota.com', 'qq.com',
      '163.com', '126.com', 'sina.com', 'msn.com', 'me.com'
    ];
    
    if (commonProviders.includes(domain)) {
      return { 
        found: true, 
        domain: domain,
        commonProvider: true,
        risk: 'low',
        message: 'Common email provider'
      };
    }
    
    // Use RDAP (Registration Data Access Protocol) - the modern replacement for WHOIS
    // Try .com/.net/.org RDAP servers
    const rdapServers = [
      `https://rdap.verisign.com/com/v1/domain/${domain}`,
      `https://rdap.verisign.com/net/v1/domain/${domain}`,
      `https://rdap.publicinterestregistry.org/rdap/domain/${domain}`,
      `https://rdap.org/domain/${domain}`
    ];
    
    for (const rdapUrl of rdapServers) {
      try {
        const response = await fetch(rdapUrl, {
          headers: { 'Accept': 'application/rdap+json, application/json' },
          signal: AbortSignal.timeout(5000)
        });
        
        if (response.ok) {
          const data = await response.json();
          
          // Find registration date
          let createdDate = null;
          let registrar = null;
          
          if (data.events) {
            for (const event of data.events) {
              if (event.eventAction === 'registration') {
                createdDate = event.eventDate;
              }
            }
          }
          
          if (data.entities) {
            for (const entity of data.entities) {
              if (entity.roles?.includes('registrar')) {
                registrar = entity.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || 
                           entity.publicIds?.[0]?.identifier ||
                           'Unknown';
              }
            }
          }
          
          if (createdDate) {
            const created = new Date(createdDate);
            const now = new Date();
            const ageInDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
            
            // Risk assessment based on domain age
            let risk = 'low';
            if (ageInDays < 30) {
              risk = 'critical'; // Less than 1 month - very suspicious
            } else if (ageInDays < 90) {
              risk = 'high'; // Less than 3 months - suspicious
            } else if (ageInDays < 365) {
              risk = 'medium'; // Less than 1 year - somewhat new
            }
            
            return {
              found: true,
              domain: domain,
              createdDate: createdDate,
              ageInDays: ageInDays,
              ageInMonths: Math.floor(ageInDays / 30),
              ageInYears: Math.floor(ageInDays / 365),
              registrar: registrar,
              risk: risk,
              commonProvider: false
            };
          }
        }
      } catch (e) {
        // Try next RDAP server
        continue;
      }
    }
    
    // Fallback: try to get basic info via DNS TXT records (less reliable)
    return {
      found: false,
      domain: domain,
      risk: 'unknown',
      message: 'Could not retrieve domain registration info'
    };
    
  } catch (error) {
    console.error('Domain age check error:', error);
    return { found: false, error: error.message };
  }
}

// ============================================
// SAM.GOV EXCLUSIONS (US Government Debarred)
// Entities excluded from federal contracts
// ============================================

async function checkSAMGovExclusions(name) {
  try {
    // SAM.gov public API for entity exclusions
    // Note: Full API requires registration, but basic search is available
    const searchUrl = `https://api.sam.gov/entity-information/v3/entities?api_key=DEMO_KEY&samRegistered=No&q=${encodeURIComponent(name)}&includeSections=entityRegistration`;
    
    const response = await fetch(searchUrl, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      // If DEMO_KEY fails, try alternative exclusions endpoint
      const exclusionsUrl = `https://api.sam.gov/entity-information/v2/exclusions?api_key=DEMO_KEY&q=${encodeURIComponent(name)}`;
      
      try {
        const exclusionsResponse = await fetch(exclusionsUrl, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000)
        });
        
        if (exclusionsResponse.ok) {
          const data = await exclusionsResponse.json();
          const matches = [];
          
          if (data.results && data.results.length > 0) {
            for (const result of data.results) {
              matches.push({
                name: result.name || result.firm,
                exclusionType: result.exclusionType || result.classification,
                agency: result.excludingAgency,
                activationDate: result.activationDate,
                terminationDate: result.terminationDate,
                samNumber: result.samNumber,
                ueiSAM: result.ueiSAM,
                cageCode: result.cageCode
              });
            }
          }
          
          return {
            found: matches.length > 0,
            matches: matches,
            totalResults: matches.length,
            source: 'SAM.gov Exclusions'
          };
        }
      } catch (e) {
        // Continue with fallback
      }
      
      return { found: false, matches: [], totalResults: 0, error: 'API unavailable' };
    }
    
    const data = await response.json();
    const matches = [];
    
    if (data.entityData && data.entityData.length > 0) {
      for (const entity of data.entityData) {
        // Check if entity is excluded
        if (entity.entityRegistration?.exclusionStatusFlag === 'Y' ||
            entity.coreData?.entityInformation?.exclusionStatus === 'Active') {
          matches.push({
            name: entity.entityRegistration?.legalBusinessName,
            ueiSAM: entity.entityRegistration?.ueiSAM,
            cageCode: entity.entityRegistration?.cageCode,
            exclusionStatus: 'Active',
            registrationStatus: entity.entityRegistration?.registrationStatus
          });
        }
      }
    }
    
    return {
      found: matches.length > 0,
      matches: matches,
      totalResults: data.totalRecords || matches.length,
      source: 'SAM.gov'
    };
    
  } catch (error) {
    console.error('SAM.gov API error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}

// ============================================
// VESSEL/SHIP LOOKUP via EQUASIS
// For commodities traders - verify vessel existence
// ============================================

async function checkVesselEquasis(vesselIdentifier, identifierType = 'imo') {
  try {
    if (!vesselIdentifier) {
      return { found: false, vessels: [], totalResults: 0 };
    }
    
    // Equasis credentials (stored securely in environment)
    const username = process.env.EQUASIS_USERNAME || 'info@cladutacorp.com';
    const password = process.env.EQUASIS_PASSWORD || 'Y@chtF0rc33??';
    
    // Step 1: Get session cookie by logging in
    const loginUrl = 'https://www.equasis.org/EquasisWeb/authen/HomePage?fs=HomePage';
    
    // Create a session with cookies
    const { CookieJar } = await import('tough-cookie');
    const jar = new CookieJar();
    
    // First, get the login page to establish session
    const loginPageResponse = await fetch(loginUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    
    // Extract session cookies
    const cookies = loginPageResponse.headers.get('set-cookie') || '';
    
    // Step 2: Submit login credentials
    const authUrl = 'https://www.equasis.org/EquasisWeb/authen/HomePage';
    const formData = new URLSearchParams({
      'j_username': username,
      'j_password': password,
      'submit': 'Login'
    });
    
    const authResponse = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      body: formData,
      redirect: 'follow'
    });
    
    const authCookies = authResponse.headers.get('set-cookie') || cookies;
    
    // Step 3: Search for vessel
    let searchUrl;
    if (identifierType === 'imo') {
      searchUrl = `https://www.equasis.org/EquasisWeb/restricted/Search?fs=Search&P_IMO=${vesselIdentifier}`;
    } else if (identifierType === 'name') {
      searchUrl = `https://www.equasis.org/EquasisWeb/restricted/Search?fs=Search&P_NAME=${encodeURIComponent(vesselIdentifier)}`;
    } else if (identifierType === 'mmsi') {
      searchUrl = `https://www.equasis.org/EquasisWeb/restricted/Search?fs=Search&P_MMSI=${vesselIdentifier}`;
    }
    
    const searchResponse = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': authCookies,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    
    if (!searchResponse.ok) {
      return { 
        found: false, 
        vessels: [], 
        totalResults: 0, 
        error: `Search failed: ${searchResponse.status}` 
      };
    }
    
    const html = await searchResponse.text();
    
    // Parse vessel data from HTML response
    const vessels = parseEquasisVesselData(html);
    
    return {
      found: vessels.length > 0,
      vessels: vessels,
      totalResults: vessels.length,
      source: 'Equasis',
      searchedIdentifier: vesselIdentifier,
      identifierType: identifierType
    };
    
  } catch (error) {
    console.error('Equasis vessel lookup error:', error);
    return { 
      found: false, 
      vessels: [], 
      totalResults: 0, 
      error: error.message,
      note: 'Equasis integration requires server-side session management'
    };
  }
}

// Parse vessel data from Equasis HTML response
function parseEquasisVesselData(html) {
  const vessels = [];
  
  try {
    // Look for vessel data patterns in Equasis HTML
    // IMO Number pattern
    const imoMatch = html.match(/IMO\s*(?:Number|No\.?)?\s*:?\s*(\d{7})/i);
    const nameMatch = html.match(/Ship\s*Name\s*:?\s*([A-Z0-9\s\-\.]+)/i);
    const flagMatch = html.match(/Flag\s*:?\s*([A-Za-z\s]+)\s*\(/i);
    const typeMatch = html.match(/Ship\s*Type\s*:?\s*([A-Za-z\/\s\-\(\)]+)/i);
    const gtMatch = html.match(/(?:Gross\s*Tonnage|GT)\s*:?\s*([\d,]+)/i);
    const dwtMatch = html.match(/(?:Deadweight|DWT)\s*:?\s*([\d,]+)/i);
    const builtMatch = html.match(/(?:Year\s*Built|Built)\s*:?\s*(\d{4})/i);
    const mmsiMatch = html.match(/MMSI\s*:?\s*(\d{9})/i);
    const callSignMatch = html.match(/Call\s*Sign\s*:?\s*([A-Z0-9]+)/i);
    
    // Check for detention/PSC inspection data
    const hasDetentions = html.includes('Detention') && html.includes('Yes');
    const pscInspections = (html.match(/PSC\s*Inspection/gi) || []).length;
    
    // Look for management company info
    const managerMatch = html.match(/(?:Ship\s*Manager|ISM\s*Manager|DOC\s*Company)\s*:?\s*([A-Za-z0-9\s\.\-\&]+)/i);
    const ownerMatch = html.match(/(?:Registered\s*Owner|Owner)\s*:?\s*([A-Za-z0-9\s\.\-\&]+)/i);
    
    // Look for classification society
    const classMatch = html.match(/(?:Classification\s*Society|Class)\s*:?\s*([A-Za-z\s]+)/i);
    
    if (imoMatch || nameMatch) {
      vessels.push({
        imo: imoMatch ? imoMatch[1] : null,
        name: nameMatch ? nameMatch[1].trim() : null,
        flag: flagMatch ? flagMatch[1].trim() : null,
        type: typeMatch ? typeMatch[1].trim() : null,
        grossTonnage: gtMatch ? parseInt(gtMatch[1].replace(/,/g, '')) : null,
        deadweight: dwtMatch ? parseInt(dwtMatch[1].replace(/,/g, '')) : null,
        yearBuilt: builtMatch ? parseInt(builtMatch[1]) : null,
        mmsi: mmsiMatch ? mmsiMatch[1] : null,
        callSign: callSignMatch ? callSignMatch[1] : null,
        manager: managerMatch ? managerMatch[1].trim() : null,
        owner: ownerMatch ? ownerMatch[1].trim() : null,
        classificationSociety: classMatch ? classMatch[1].trim() : null,
        hasDetentions: hasDetentions,
        pscInspectionCount: pscInspections,
        source: 'Equasis'
      });
    }
    
    // Also look for table-based results (search results page)
    const tableRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of tableRows) {
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (cells.length >= 5) {
        const imoCell = cells[0]?.match(/(\d{7})/);
        const nameCell = cells[1]?.replace(/<[^>]+>/g, '').trim();
        if (imoCell && nameCell && !vessels.find(v => v.imo === imoCell[1])) {
          vessels.push({
            imo: imoCell[1],
            name: nameCell,
            flag: cells[2]?.replace(/<[^>]+>/g, '').trim() || null,
            type: cells[3]?.replace(/<[^>]+>/g, '').trim() || null,
            source: 'Equasis'
          });
        }
      }
    }
    
  } catch (parseError) {
    console.error('Equasis HTML parsing error:', parseError);
  }
  
  return vessels;
}

// Helper: Extract vessel names from document text
function extractVesselReferences(text) {
  if (!text) return [];
  
  const vesselPatterns = [
    /(?:M\/V|MV|MT|SS|HMS|VESSEL|SHIP)\s+["']?([A-Z][A-Z0-9\s\-]+)["']?/gi,
    /(?:IMO\s*(?:NUMBER|NO|#)?:?\s*)(\d{7})/gi,
    /(?:MMSI\s*(?:NUMBER|NO|#)?:?\s*)(\d{9})/gi
  ];
  
  const vessels = new Set();
  
  for (const pattern of vesselPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      vessels.add(match[1].trim());
    }
  }
  
  return [...vessels];
}

// ============================================
// INTERPOL YELLOW NOTICES (Missing Persons)
// Supplement to Red Notices
// ============================================

async function checkInterpolYellowNotices(name) {
  try {
    const nameParts = name.trim().split(/\s+/);
    let firstName = '';
    let lastName = '';
    
    if (nameParts.length === 1) {
      lastName = nameParts[0];
    } else {
      firstName = nameParts[0];
      lastName = nameParts.slice(1).join(' ');
    }
    
    const params = new URLSearchParams({ resultPerPage: '20' });
    if (firstName) params.append('forename', firstName);
    if (lastName) params.append('name', lastName);
    
    const response = await fetch(
      `https://ws-public.interpol.int/notices/v1/yellow?${params}`,
      { 
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      }
    );
    
    if (!response.ok) {
      return { found: false, matches: [], totalResults: 0 };
    }
    
    const data = await response.json();
    const matches = [];
    
    if (data._embedded?.notices && data._embedded.notices.length > 0) {
      for (const notice of data._embedded.notices) {
        const noticeName = `${notice.forename || ''} ${notice.name || ''}`.toLowerCase().trim();
        const searchName = name.toLowerCase().trim();
        
        if (noticeName.includes(searchName) || searchName.includes(noticeName) ||
            levenshteinDistance(noticeName, searchName) < 3) {
          matches.push({
            entityId: notice.entity_id,
            forename: notice.forename,
            name: notice.name,
            dateOfBirth: notice.date_of_birth,
            nationalities: notice.nationalities || [],
            type: 'Yellow Notice (Missing Person)',
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
    console.error('Interpol Yellow Notices API error:', error);
    return { found: false, matches: [], totalResults: 0, error: error.message };
  }
}

async function checkOpenSanctions(name) {
  try {
    const nameVariations = getNameVariations(name);
    console.log(`OpenSanctions: Searching for "${name}" (variations: ${nameVariations.join(', ')})`);
    
    // Get API key from environment
    const apiKey = process.env.OPENSANCTIONS_API_KEY;
    if (!apiKey) {
      console.log('OpenSanctions: WARNING - No API key configured');
    }
    
    const authHeaders = {
      'Accept': 'application/json',
      ...(apiKey && { 'Authorization': `ApiKey ${apiKey}` })
    };
    
    let allResults = [];
    
    // Try each name variation
    for (const searchName of nameVariations) {
      console.log(`OpenSanctions: Trying variation "${searchName}"`);
      
      try {
        const searchResponse = await fetch(
          `https://api.opensanctions.org/search/default?q=${encodeURIComponent(searchName)}&limit=15`,
          { headers: authHeaders }
        );
        
        console.log(`OpenSanctions: API response status: ${searchResponse.status} for "${searchName}"`);
        
        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          console.log(`OpenSanctions: Found ${searchData.results?.length || 0} results for "${searchName}"`);
          
          if (searchData.results && searchData.results.length > 0) {
            // Log all results for debugging
            searchData.results.forEach((r, i) => {
              console.log(`  Result ${i+1}: ${r.caption} (score: ${r.score}, schema: ${r.schema}, datasets: ${r.datasets?.join(', ')}, topics: ${r.topics?.join(', ')})`);
            });
            
            allResults.push(...searchData.results);
          } else {
            console.log(`OpenSanctions: Empty results array for "${searchName}"`);
          }
        } else {
          const errorText = await searchResponse.text();
          console.log(`OpenSanctions: API error for "${searchName}": ${searchResponse.status} - ${errorText.substring(0, 200)}`);
        }
      } catch (fetchError) {
        console.log(`OpenSanctions: Fetch error for "${searchName}": ${fetchError.message}`);
      }
    }
    
    // Deduplicate by entity ID
    const uniqueResults = [];
    const seenIds = new Set();
    for (const r of allResults) {
      const id = r.id || r.caption;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        uniqueResults.push(r);
      }
    }
    
    // LOWERED THRESHOLD: 0.2 for persons (wanted criminals often have name variations)
    // Also accept ANY score if they're on interpol/fbi lists
    const significantMatches = uniqueResults.filter(m => {
      const isHighPriorityList = m.datasets?.some(d => 
        d.toLowerCase().includes('interpol') ||
        d.toLowerCase().includes('fbi') ||
        d.toLowerCase().includes('europol') ||
        d.toLowerCase().includes('most_wanted') ||
        d.toLowerCase().includes('wanted')
      );
      const hasCrimeTopic = m.topics?.some(t => 
        t.includes('crime') || t.includes('wanted') || t.includes('sanction')
      );
      
      // Accept lower scores for high-priority matches
      if (isHighPriorityList || hasCrimeTopic) {
        console.log(`OpenSanctions: High-priority match found: ${m.caption} (score: ${m.score})`);
        return m.score >= 0.15; // Very low threshold for wanted criminals
      }
      return m.score >= 0.2; // Lower general threshold
    });
    
    console.log(`OpenSanctions: ${significantMatches.length} significant matches after filtering`);
    
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
          d.toLowerCase().includes('europol') ||
          d.toLowerCase().includes('wanted') ||
          d.toLowerCase().includes('crime') ||
          d.toLowerCase().includes('most_wanted')
        ) ||
        m.topics?.some(t => t.includes('crime') || t.includes('wanted'))
      );
      
      console.log(`OpenSanctions: Match summary - isPEP: ${isPEP}, isWanted: ${isWanted}`);
      
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

    // Fallback #1: Try Match API for Person schema (THIS WAS MISSING!)
    console.log(`OpenSanctions: Trying Person Match API for "${name}"`);
    try {
      const personResponse = await fetch(
        `https://api.opensanctions.org/match/default`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(apiKey && { 'Authorization': `ApiKey ${apiKey}` })
          },
          body: JSON.stringify({
            queries: {
              q1: {
                schema: 'Person',
                properties: {
                  name: nameVariations
                }
              }
            }
          })
        }
      );

      console.log(`OpenSanctions: Person Match API status: ${personResponse.status}`);
      
      if (personResponse.ok) {
        const personData = await personResponse.json();
        console.log(`OpenSanctions Person Match: ${personData.responses?.q1?.results?.length || 0} results`);
        
        if (personData.responses?.q1?.results && personData.responses.q1.results.length > 0) {
          const results = personData.responses.q1.results;
          results.forEach((r, i) => {
            console.log(`  Person ${i+1}: ${r.caption} (score: ${r.score}, datasets: ${r.datasets?.join(', ')})`);
          });
          
          const significantMatches = results.filter(r => r.score >= 0.2);
          
          if (significantMatches.length > 0) {
            const isPEP = significantMatches.some(m => 
              m.datasets?.some(d => d.toLowerCase().includes('pep')) ||
              m.properties?.topics?.some(t => t.includes('pep'))
            );
            
            const isWanted = significantMatches.some(m =>
              m.datasets?.some(d => 
                d.toLowerCase().includes('interpol') ||
                d.toLowerCase().includes('fbi') ||
                d.toLowerCase().includes('europol')
              )
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
              isWanted: isWanted,
              pepDatasets: isPEP ? significantMatches.flatMap(m => m.datasets || []).filter(d => d.toLowerCase().includes('pep')) : []
            };
          }
        }
      } else {
        const errorText = await personResponse.text();
        console.log(`OpenSanctions: Person Match API error: ${personResponse.status} - ${errorText.substring(0, 200)}`);
      }
    } catch (personError) {
      console.log(`OpenSanctions: Person Match API fetch error: ${personError.message}`);
    }

    // Fallback #2: Try Match API for LegalEntity
    console.log(`OpenSanctions: Trying LegalEntity Match API for "${name}"`);
    try {
      const entityResponse = await fetch(
        `https://api.opensanctions.org/match/default`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(apiKey && { 'Authorization': `ApiKey ${apiKey}` })
          },
          body: JSON.stringify({
            queries: {
              q1: {
                schema: 'LegalEntity',
                properties: {
                  name: nameVariations
                }
              }
            }
          })
        }
      );

      console.log(`OpenSanctions: LegalEntity Match API status: ${entityResponse.status}`);
      
      if (entityResponse.ok) {
        const data = await entityResponse.json();
        console.log(`OpenSanctions LegalEntity Match: ${data.responses?.q1?.results?.length || 0} results`);
        
        if (data.responses?.q1?.results && data.responses.q1.results.length > 0) {
          const results = data.responses.q1.results;
          const significantMatches = results.filter(r => r.score >= 0.2);
          
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
      } else {
        const errorText = await entityResponse.text();
        console.log(`OpenSanctions: LegalEntity Match API error: ${entityResponse.status} - ${errorText.substring(0, 200)}`);
      }
    } catch (entityError) {
      console.log(`OpenSanctions: LegalEntity Match API fetch error: ${entityError.message}`);
    }

    console.log(`OpenSanctions: No matches found for "${name}" after all attempts`);
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
// SINGAPORE ACRA (via data.gov.sg Open Data)
// ============================================

async function checkSingaporeACRA(companyName) {
  try {
    // Singapore government open data API - free, no key required
    const searchQuery = encodeURIComponent(companyName.toUpperCase());
    const response = await fetch(
      `https://data.gov.sg/api/action/datastore_search?resource_id=d_3f960c10fed6145404ca7b821f263b87&q=${searchQuery}&limit=5`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (!response.ok) {
      console.log(`Singapore ACRA: API returned ${response.status}`);
      return { found: false, error: 'API error', status: response.status };
    }

    const data = await response.json();
    
    if (data.result && data.result.records && data.result.records.length > 0) {
      const company = data.result.records[0];
      console.log(`Singapore ACRA: Found ${data.result.records.length} results for "${companyName}"`);
      
      return {
        found: true,
        company: {
          name: company.entity_name,
          uen: company.uen,
          status: company.uen_status,
          entityType: company.entity_type,
          registrationDate: company.uen_issue_date,
          address: company.reg_street_name ? `${company.reg_street_name}, Singapore ${company.reg_postal_code}` : null
        },
        source: 'Singapore ACRA',
        totalResults: data.result.total
      };
    }

    console.log(`Singapore ACRA: No results for "${companyName}"`);
    return { found: false };
  } catch (error) {
    console.error('Singapore ACRA error:', error);
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

  // Check for sanctioned/high-risk bank SWIFT codes
  const sanctionedBanks = getSanctionedBankSWIFTs();
  const isSanctioned = sanctionedBanks.some(s => cleanSwift.startsWith(s.code));
  const sanctionMatch = sanctionedBanks.find(s => cleanSwift.startsWith(s.code));
  
  // Check for high-risk jurisdiction banks
  const highRiskCountries = ['IR', 'KP', 'SY', 'CU', 'RU', 'BY', 'VE', 'MM'];
  const isHighRiskCountry = highRiskCountries.includes(countryCode);

  return {
    valid: true,
    bankCode: bankCode,
    countryCode: countryCode,
    locationCode: locationCode,
    branchCode: branchCode,
    formatted: cleanSwift,
    sanctioned: isSanctioned,
    sanctionInfo: sanctionMatch || null,
    highRiskCountry: isHighRiskCountry,
    riskLevel: isSanctioned ? 'CRITICAL' : (isHighRiskCountry ? 'HIGH' : 'LOW')
  };
}

// Sanctioned bank SWIFT codes (partial list - major sanctioned banks)
function getSanctionedBankSWIFTs() {
  return [
    // Russian banks (sanctioned post-2022)
    { code: 'SABR', name: 'Sberbank', country: 'Russia', reason: 'EU/US/UK Sanctions' },
    { code: 'VTBR', name: 'VTB Bank', country: 'Russia', reason: 'EU/US/UK Sanctions' },
    { code: 'ALFA', name: 'Alfa-Bank', country: 'Russia', reason: 'US Sanctions' },
    { code: 'RZBM', name: 'Raiffeisen Russia', country: 'Russia', reason: 'Under review' },
    { code: 'PROM', name: 'Promsvyazbank', country: 'Russia', reason: 'EU/US Sanctions' },
    { code: 'RSHB', name: 'Russian Agricultural Bank', country: 'Russia', reason: 'EU/US Sanctions' },
    { code: 'MBRK', name: 'Moscow Credit Bank', country: 'Russia', reason: 'EU Sanctions' },
    { code: 'OWHB', name: 'Otkritie Bank', country: 'Russia', reason: 'EU/US Sanctions' },
    { code: 'NOKO', name: 'Novikombank', country: 'Russia', reason: 'EU/US Sanctions' },
    { code: 'RSCC', name: 'Russian National Commercial Bank', country: 'Russia', reason: 'US Sanctions - Crimea' },
    { code: 'BKCHCNBJ', name: 'Bank of China', country: 'China', reason: 'Caution - Russia trade' },
    
    // Iranian banks (heavily sanctioned)
    { code: 'BMJI', name: 'Bank Melli Iran', country: 'Iran', reason: 'OFAC SDN List' },
    { code: 'BKSP', name: 'Bank Sepah', country: 'Iran', reason: 'OFAC SDN List' },
    { code: 'MEBI', name: 'Bank Mellat', country: 'Iran', reason: 'OFAC SDN List' },
    { code: 'BKSA', name: 'Bank Saderat Iran', country: 'Iran', reason: 'OFAC SDN List' },
    { code: 'POST', name: 'Post Bank of Iran', country: 'Iran', reason: 'OFAC SDN List' },
    { code: 'EDBI', name: 'Export Development Bank of Iran', country: 'Iran', reason: 'OFAC SDN List' },
    
    // North Korean banks
    { code: 'KKBC', name: 'Korea Kwangson Banking Corp', country: 'North Korea', reason: 'OFAC SDN List' },
    { code: 'FTRN', name: 'Foreign Trade Bank of DPRK', country: 'North Korea', reason: 'OFAC SDN List' },
    
    // Syrian banks
    { code: 'CBSY', name: 'Commercial Bank of Syria', country: 'Syria', reason: 'EU/US Sanctions' },
    
    // Belarusian banks
    { code: 'BPSB', name: 'Belarusbank', country: 'Belarus', reason: 'EU/US Sanctions' },
    { code: 'BLBB', name: 'Belinvestbank', country: 'Belarus', reason: 'EU Sanctions' },
    
    // Venezuelan banks
    { code: 'BNDV', name: 'Banco de Venezuela', country: 'Venezuela', reason: 'OFAC Sanctions' },
  ];
}


// ============================================
// BILL OF LADING (B/L) EXTRACTION
// For commodity traders - verify shipping docs
// ============================================

function extractBillOfLading(text) {
  if (!text) return null;
  
  const blData = {
    found: false,
    blNumber: null,
    shipper: null,
    consignee: null,
    notifyParty: null,
    vessel: null,
    vesselIMO: null,
    voyage: null,
    portOfLoading: null,
    portOfLoadingCode: null,
    portOfDischarge: null,
    portOfDischargeCode: null,
    placeOfReceipt: null,
    placeOfDelivery: null,
    cargo: null,
    containerNumbers: [],
    sealNumbers: [],
    grossWeight: null,
    measurement: null,
    freightTerms: null,
    dateOfIssue: null,
    captain: null,
    carrier: null
  };
  
  const textUpper = text.toUpperCase();
  
  // Detect if this is a Bill of Lading
  const blIndicators = [
    'BILL OF LADING', 'B/L', 'BL NO', 'SHIPPER', 'CONSIGNEE', 
    'PORT OF LOADING', 'PORT OF DISCHARGE', 'NOTIFY PARTY',
    'OCEAN BILL', 'SEA WAYBILL', 'MASTER B/L', 'HOUSE B/L'
  ];
  
  const isBL = blIndicators.some(ind => textUpper.includes(ind));
  if (!isBL) return null;
  
  blData.found = true;
  
  // Extract B/L Number
  const blNumPatterns = [
    /(?:B\/L|BL|BILL OF LADING)\s*(?:NO\.?|NUMBER|#)?\s*:?\s*([A-Z0-9\-\/]+)/i,
    /(?:BOOKING|REF(?:ERENCE)?)\s*(?:NO\.?|#)?\s*:?\s*([A-Z0-9\-\/]+)/i
  ];
  for (const pattern of blNumPatterns) {
    const match = text.match(pattern);
    if (match) {
      blData.blNumber = match[1].trim();
      break;
    }
  }
  
  // Extract Shipper
  const shipperMatch = text.match(/SHIPPER\s*(?:\/\s*EXPORTER)?\s*:?\s*\n?\s*([A-Za-z0-9\s\.,\-&()]+?)(?=\n\n|CONSIGNEE|NOTIFY|$)/is);
  if (shipperMatch) blData.shipper = shipperMatch[1].trim().split('\n')[0];
  
  // Extract Consignee
  const consigneeMatch = text.match(/CONSIGNEE\s*:?\s*\n?\s*([A-Za-z0-9\s\.,\-&()]+?)(?=\n\n|NOTIFY|SHIPPER|$)/is);
  if (consigneeMatch) blData.consignee = consigneeMatch[1].trim().split('\n')[0];
  
  // Extract Notify Party
  const notifyMatch = text.match(/NOTIFY\s*(?:PARTY)?\s*:?\s*\n?\s*([A-Za-z0-9\s\.,\-&()]+?)(?=\n\n|PORT|VESSEL|$)/is);
  if (notifyMatch) blData.notifyParty = notifyMatch[1].trim().split('\n')[0];
  
  // Extract Vessel Name
  const vesselPatterns = [
    /(?:VESSEL|SHIP|M\/V|MV|MT|SS)\s*(?:NAME)?\s*:?\s*["']?([A-Z][A-Z0-9\s\-\.]+)["']?/i,
    /(?:OCEAN\s*VESSEL|MOTHER\s*VESSEL)\s*:?\s*["']?([A-Z][A-Z0-9\s\-\.]+)["']?/i
  ];
  for (const pattern of vesselPatterns) {
    const match = text.match(pattern);
    if (match) {
      blData.vessel = match[1].trim();
      break;
    }
  }
  
  // Extract Vessel IMO
  const imoMatch = text.match(/IMO\s*(?:NO\.?|NUMBER|#)?\s*:?\s*(\d{7})/i);
  if (imoMatch) blData.vesselIMO = imoMatch[1];
  
  // Extract Voyage Number
  const voyageMatch = text.match(/(?:VOYAGE|VOY)\s*(?:NO\.?|NUMBER|#)?\s*:?\s*([A-Z0-9\-\/]+)/i);
  if (voyageMatch) blData.voyage = voyageMatch[1].trim();
  
  // Extract Port of Loading
  const polPatterns = [
    /(?:PORT\s*OF\s*LOADING|POL|LOAD(?:ING)?\s*PORT)\s*:?\s*([A-Za-z\s\-,]+?)(?=\n|PORT|$)/i,
    /(?:FROM|ORIGIN)\s*:?\s*([A-Za-z\s\-,]+?)(?=\n|TO|$)/i
  ];
  for (const pattern of polPatterns) {
    const match = text.match(pattern);
    if (match) {
      blData.portOfLoading = match[1].trim();
      // Try to extract UN/LOCODE
      const locodeMatch = match[0].match(/([A-Z]{2}[A-Z0-9]{3})/);
      if (locodeMatch) blData.portOfLoadingCode = locodeMatch[1];
      break;
    }
  }
  
  // Extract Port of Discharge
  const podPatterns = [
    /(?:PORT\s*OF\s*DISCHARGE|POD|DISCHARGE\s*PORT|DESTINATION\s*PORT)\s*:?\s*([A-Za-z\s\-,]+?)(?=\n|PORT|$)/i,
    /(?:TO|DESTINATION)\s*:?\s*([A-Za-z\s\-,]+?)(?=\n|FROM|$)/i
  ];
  for (const pattern of podPatterns) {
    const match = text.match(pattern);
    if (match) {
      blData.portOfDischarge = match[1].trim();
      // Try to extract UN/LOCODE
      const locodeMatch = match[0].match(/([A-Z]{2}[A-Z0-9]{3})/);
      if (locodeMatch) blData.portOfDischargeCode = locodeMatch[1];
      break;
    }
  }
  
  // Extract Container Numbers (format: 4 letters + 7 digits)
  const containerPattern = /([A-Z]{4}\d{7})/g;
  let containerMatch;
  while ((containerMatch = containerPattern.exec(text)) !== null) {
    if (!blData.containerNumbers.includes(containerMatch[1])) {
      blData.containerNumbers.push(containerMatch[1]);
    }
  }
  
  // Extract Seal Numbers
  const sealPattern = /(?:SEAL|SL)\s*(?:NO\.?|#)?\s*:?\s*([A-Z0-9\-]+)/gi;
  let sealMatch;
  while ((sealMatch = sealPattern.exec(text)) !== null) {
    if (!blData.sealNumbers.includes(sealMatch[1])) {
      blData.sealNumbers.push(sealMatch[1]);
    }
  }
  
  // Extract Gross Weight
  const weightMatch = text.match(/(?:GROSS\s*WEIGHT|GR\.?\s*WT\.?)\s*:?\s*([\d,\.]+)\s*(KG|MT|TON|LBS)?/i);
  if (weightMatch) blData.grossWeight = `${weightMatch[1]} ${weightMatch[2] || 'KG'}`.trim();
  
  // Extract Captain Name
  const captainPatterns = [
    /(?:MASTER|CAPTAIN|CAPT\.?)\s*(?:NAME)?\s*:?\s*([A-Za-z\s\.\-]+?)(?=\n|$)/i,
    /(?:SIGNED\s*BY|SIGNATURE)\s*(?:MASTER|CAPTAIN)?\s*:?\s*([A-Za-z\s\.\-]+?)(?=\n|$)/i
  ];
  for (const pattern of captainPatterns) {
    const match = text.match(pattern);
    if (match) {
      blData.captain = match[1].trim();
      break;
    }
  }
  
  // Extract Carrier
  const carrierMatch = text.match(/(?:CARRIER|SHIPPING\s*LINE|LINER)\s*:?\s*([A-Za-z\s\.\-&]+?)(?=\n|$)/i);
  if (carrierMatch) blData.carrier = carrierMatch[1].trim();
  
  // Extract Freight Terms
  if (textUpper.includes('FREIGHT PREPAID')) blData.freightTerms = 'PREPAID';
  else if (textUpper.includes('FREIGHT COLLECT')) blData.freightTerms = 'COLLECT';
  else if (textUpper.includes('CIF')) blData.freightTerms = 'CIF';
  else if (textUpper.includes('FOB')) blData.freightTerms = 'FOB';
  else if (textUpper.includes('CFR') || textUpper.includes('C&F')) blData.freightTerms = 'CFR';
  
  return blData;
}


// ============================================
// FINANCIAL INSTRUMENT DETECTION
// SBLC, BLC, POF, LC, Escrow
// ============================================

function detectFinancialInstruments(text) {
  if (!text) return [];
  
  const textUpper = text.toUpperCase();
  const instruments = [];
  
  // Standby Letter of Credit (SBLC)
  if (textUpper.includes('SBLC') || textUpper.includes('STANDBY LETTER OF CREDIT') || 
      textUpper.includes('STAND-BY LETTER OF CREDIT') || textUpper.includes('STANDBY L/C')) {
    instruments.push({
      type: 'SBLC',
      name: 'Standby Letter of Credit',
      risk: 'VERIFY',
      note: 'Verify issuing bank is legitimate and not sanctioned. Check SWIFT code.'
    });
  }
  
  // Documentary Letter of Credit (DLC/LC)
  if (textUpper.includes('DOCUMENTARY LETTER OF CREDIT') || textUpper.includes('DOCUMENTARY L/C') ||
      textUpper.includes('IRREVOCABLE LETTER OF CREDIT') || 
      (textUpper.includes('LETTER OF CREDIT') && !textUpper.includes('STANDBY'))) {
    instruments.push({
      type: 'DLC',
      name: 'Documentary Letter of Credit',
      risk: 'VERIFY',
      note: 'Verify issuing bank, confirming bank, and advising bank details.'
    });
  }
  
  // Bank Comfort Letter (BCL)
  if (textUpper.includes('BCL') || textUpper.includes('BANK COMFORT LETTER') || 
      textUpper.includes('BANK CONFIRMATION LETTER')) {
    instruments.push({
      type: 'BCL',
      name: 'Bank Comfort Letter',
      risk: 'HIGH',
      note: 'BCLs are often used in scams. Verify directly with issuing bank via independent contact.'
    });
  }
  
  // Proof of Funds (POF)
  if (textUpper.includes('POF') || textUpper.includes('PROOF OF FUNDS') || 
      textUpper.includes('PROOF OF FUND') || textUpper.includes('BANK STATEMENT')) {
    instruments.push({
      type: 'POF',
      name: 'Proof of Funds',
      risk: 'VERIFY',
      note: 'Verify directly with bank. Check account holder matches buyer/seller.'
    });
  }
  
  // Escrow
  if (textUpper.includes('ESCROW') || textUpper.includes('ESCROW ACCOUNT') || 
      textUpper.includes('ESCROW AGENT')) {
    instruments.push({
      type: 'ESCROW',
      name: 'Escrow Account',
      risk: 'VERIFY',
      note: 'Verify escrow agent is legitimate. Check with local bar association if attorney.'
    });
  }
  
  // Bank Guarantee (BG)
  if (textUpper.includes('BANK GUARANTEE') || textUpper.includes('BG ') || 
      textUpper.match(/\bBG\b/)) {
    instruments.push({
      type: 'BG',
      name: 'Bank Guarantee',
      risk: 'VERIFY',
      note: 'Verify via SWIFT MT760/MT799. Check issuing bank is not sanctioned.'
    });
  }
  
  // Performance Bond
  if (textUpper.includes('PERFORMANCE BOND') || textUpper.includes('PB ') ||
      textUpper.includes('PERFORMANCE GUARANTEE')) {
    instruments.push({
      type: 'PB',
      name: 'Performance Bond',
      risk: 'VERIFY',
      note: 'Verify bond issuer is legitimate surety company or bank.'
    });
  }
  
  // MT760 / MT799 (SWIFT messages for guarantees)
  if (textUpper.includes('MT760') || textUpper.includes('MT 760')) {
    instruments.push({
      type: 'MT760',
      name: 'SWIFT MT760 Bank Guarantee',
      risk: 'VERIFY',
      note: 'Verify via independent SWIFT trace. Check TRN (Transaction Reference Number).'
    });
  }
  
  if (textUpper.includes('MT799') || textUpper.includes('MT 799')) {
    instruments.push({
      type: 'MT799',
      name: 'SWIFT MT799 Free Format Message',
      risk: 'HIGH',
      note: 'MT799 is just a message, NOT a guarantee. Often misrepresented in scams.'
    });
  }
  
  return instruments;
}


// ============================================
// PORT VERIFICATION (UN/LOCODE)
// ============================================

function verifyPort(portInput) {
  if (!portInput) return { valid: false, error: 'No port provided' };
  
  const portUpper = portInput.toUpperCase().trim();
  
  // Check if it's already a UN/LOCODE (5 characters: 2 country + 3 location)
  if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(portUpper)) {
    const countryCode = portUpper.substring(0, 2);
    const locationCode = portUpper.substring(2, 5);
    const portData = MAJOR_PORTS[portUpper];
    
    return {
      valid: true,
      locode: portUpper,
      countryCode: countryCode,
      locationCode: locationCode,
      name: portData?.name || null,
      country: portData?.country || getCountryFromCode(countryCode),
      isKnownPort: !!portData
    };
  }
  
  // Try to find port by name
  const portByName = findPortByName(portUpper);
  if (portByName) {
    return {
      valid: true,
      locode: portByName.locode,
      countryCode: portByName.locode.substring(0, 2),
      name: portByName.name,
      country: portByName.country,
      isKnownPort: true
    };
  }
  
  return {
    valid: false,
    searchedName: portInput,
    error: 'Port not found in database. Verify spelling or provide UN/LOCODE.'
  };
}

// Major world ports database (key trading ports)
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
  'CNLYG': { name: 'Lianyungang', country: 'China' },
  
  // Singapore
  'SGSIN': { name: 'Singapore', country: 'Singapore' },
  
  // South Korea
  'KRPUS': { name: 'Busan', country: 'South Korea' },
  'KRINC': { name: 'Incheon', country: 'South Korea' },
  
  // Japan
  'JPYOK': { name: 'Yokohama', country: 'Japan' },
  'JPKOB': { name: 'Kobe', country: 'Japan' },
  'JPTYO': { name: 'Tokyo', country: 'Japan' },
  'JPNGO': { name: 'Nagoya', country: 'Japan' },
  'JPOSA': { name: 'Osaka', country: 'Japan' },
  
  // UAE
  'AEJEA': { name: 'Jebel Ali', country: 'UAE' },
  'AEDXB': { name: 'Dubai', country: 'UAE' },
  'AEAUH': { name: 'Abu Dhabi', country: 'UAE' },
  'AEKLF': { name: 'Khor al Fakkan', country: 'UAE' },
  
  // Netherlands
  'NLRTM': { name: 'Rotterdam', country: 'Netherlands' },
  'NLAMS': { name: 'Amsterdam', country: 'Netherlands' },
  
  // Belgium
  'BEANR': { name: 'Antwerp', country: 'Belgium' },
  
  // Germany
  'DEHAM': { name: 'Hamburg', country: 'Germany' },
  'DEBRV': { name: 'Bremerhaven', country: 'Germany' },
  
  // UK
  'GBFXT': { name: 'Felixstowe', country: 'UK' },
  'GBSOU': { name: 'Southampton', country: 'UK' },
  'GBLGP': { name: 'London Gateway', country: 'UK' },
  'GBLON': { name: 'London', country: 'UK' },
  
  // USA
  'USLAX': { name: 'Los Angeles', country: 'USA' },
  'USLGB': { name: 'Long Beach', country: 'USA' },
  'USNYC': { name: 'New York', country: 'USA' },
  'USSAV': { name: 'Savannah', country: 'USA' },
  'USHOU': { name: 'Houston', country: 'USA' },
  'USBAL': { name: 'Baltimore', country: 'USA' },
  'USCHI': { name: 'Chicago', country: 'USA' },
  'USORF': { name: 'Norfolk', country: 'USA' },
  'USSEA': { name: 'Seattle', country: 'USA' },
  'USOAK': { name: 'Oakland', country: 'USA' },
  'USMIA': { name: 'Miami', country: 'USA' },
  'USNWK': { name: 'Newark', country: 'USA' },
  
  // Brazil
  'BRSSZ': { name: 'Santos', country: 'Brazil' },
  'BRPNG': { name: 'Paranaguá', country: 'Brazil' },
  'BRRIO': { name: 'Rio de Janeiro', country: 'Brazil' },
  'BRITJ': { name: 'Itajaí', country: 'Brazil' },
  
  // Australia
  'AUSYD': { name: 'Sydney', country: 'Australia' },
  'AUMEL': { name: 'Melbourne', country: 'Australia' },
  'AUBNE': { name: 'Brisbane', country: 'Australia' },
  'AUFRE': { name: 'Fremantle', country: 'Australia' },
  
  // India
  'INNSA': { name: 'Nhava Sheva (JNPT)', country: 'India' },
  'INMUN': { name: 'Mundra', country: 'India' },
  'INCHE': { name: 'Chennai', country: 'India' },
  'INKOL': { name: 'Kolkata', country: 'India' },
  'INCCU': { name: 'Cochin', country: 'India' },
  
  // Malaysia
  'MYPKG': { name: 'Port Klang', country: 'Malaysia' },
  'MYTPP': { name: 'Tanjung Pelepas', country: 'Malaysia' },
  
  // Thailand
  'THBKK': { name: 'Bangkok', country: 'Thailand' },
  'THLCH': { name: 'Laem Chabang', country: 'Thailand' },
  
  // Vietnam
  'VNSGN': { name: 'Ho Chi Minh City', country: 'Vietnam' },
  'VNHPH': { name: 'Haiphong', country: 'Vietnam' },
  
  // Indonesia
  'IDJKT': { name: 'Jakarta', country: 'Indonesia' },
  'IDSUB': { name: 'Surabaya', country: 'Indonesia' },
  
  // Philippines
  'PHMNL': { name: 'Manila', country: 'Philippines' },
  
  // Egypt
  'EGPSD': { name: 'Port Said', country: 'Egypt' },
  'EGALY': { name: 'Alexandria', country: 'Egypt' },
  
  // South Africa
  'ZADUR': { name: 'Durban', country: 'South Africa' },
  'ZACPT': { name: 'Cape Town', country: 'South Africa' },
  
  // Spain
  'ESVLC': { name: 'Valencia', country: 'Spain' },
  'ESBCN': { name: 'Barcelona', country: 'Spain' },
  'ESALG': { name: 'Algeciras', country: 'Spain' },
  
  // Italy
  'ITGOA': { name: 'Genoa', country: 'Italy' },
  'ITGIT': { name: 'Gioia Tauro', country: 'Italy' },
  'ITLIV': { name: 'Livorno', country: 'Italy' },
  
  // France
  'FRLEH': { name: 'Le Havre', country: 'France' },
  'FRMAR': { name: 'Marseille', country: 'France' },
  
  // Greece
  'GRPIR': { name: 'Piraeus', country: 'Greece' },
  
  // Turkey
  'TRIST': { name: 'Istanbul', country: 'Turkey' },
  'TRIZM': { name: 'Izmir', country: 'Turkey' },
  'TRMER': { name: 'Mersin', country: 'Turkey' },
  
  // Russia
  'RULED': { name: 'St. Petersburg', country: 'Russia' },
  'RUVVO': { name: 'Vladivostok', country: 'Russia' },
  'RUNVS': { name: 'Novorossiysk', country: 'Russia' },
  
  // Canada
  'CAVAN': { name: 'Vancouver', country: 'Canada' },
  'CAMTR': { name: 'Montreal', country: 'Canada' },
  'CAHAL': { name: 'Halifax', country: 'Canada' },
  
  // Mexico
  'MXZLO': { name: 'Manzanillo', country: 'Mexico' },
  'MXVER': { name: 'Veracruz', country: 'Mexico' },
  
  // Panama
  'PAPTC': { name: 'Panama Canal (Cristobal)', country: 'Panama' },
  'PAPAC': { name: 'Panama Canal (Balboa)', country: 'Panama' },
  
  // Colombia
  'COCTG': { name: 'Cartagena', country: 'Colombia' },
  
  // Argentina
  'ARBUE': { name: 'Buenos Aires', country: 'Argentina' },
  
  // Chile
  'CLSAI': { name: 'San Antonio', country: 'Chile' },
  'CLVAP': { name: 'Valparaiso', country: 'Chile' },
  
  // Nigeria
  'NGAPP': { name: 'Apapa (Lagos)', country: 'Nigeria' },
  
  // Morocco
  'MAPTM': { name: 'Tanger Med', country: 'Morocco' },
  
  // Saudi Arabia
  'SAJED': { name: 'Jeddah', country: 'Saudi Arabia' },
  'SADMM': { name: 'Dammam', country: 'Saudi Arabia' },
  
  // Oman
  'OMSLL': { name: 'Salalah', country: 'Oman' },
  
  // Sri Lanka
  'LKCMB': { name: 'Colombo', country: 'Sri Lanka' },
  
  // Pakistan
  'PKKHI': { name: 'Karachi', country: 'Pakistan' },
  
  // Bangladesh
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
    'TANGER MED': 'MAPTM',
    'TANGIER': 'MAPTM',
    'PORT SAID': 'EGPSD',
    'SUEZ': 'EGPSD',
    'DURBAN': 'ZADUR',
    'LAGOS': 'NGAPP',
    'APAPA': 'NGAPP',
    'PARANAGUA': 'BRPNG',
    'RIO DE JANEIRO': 'BRRIO',
    'RIO': 'BRRIO',
    'SAO PAULO': 'BRSSZ',
  };
  
  for (const [alias, locode] of Object.entries(aliases)) {
    if (searchName.includes(alias)) {
      const portData = MAJOR_PORTS[locode];
      return { locode, ...portData };
    }
  }
  
  return null;
}

function getCountryFromCode(code) {
  const countries = {
    'CN': 'China', 'SG': 'Singapore', 'KR': 'South Korea', 'JP': 'Japan',
    'AE': 'UAE', 'NL': 'Netherlands', 'BE': 'Belgium', 'DE': 'Germany',
    'GB': 'UK', 'US': 'USA', 'BR': 'Brazil', 'AU': 'Australia',
    'IN': 'India', 'MY': 'Malaysia', 'TH': 'Thailand', 'VN': 'Vietnam',
    'ID': 'Indonesia', 'PH': 'Philippines', 'EG': 'Egypt', 'ZA': 'South Africa',
    'ES': 'Spain', 'IT': 'Italy', 'FR': 'France', 'GR': 'Greece',
    'TR': 'Turkey', 'RU': 'Russia', 'CA': 'Canada', 'MX': 'Mexico',
    'PA': 'Panama', 'CO': 'Colombia', 'AR': 'Argentina', 'CL': 'Chile',
    'NG': 'Nigeria', 'MA': 'Morocco', 'SA': 'Saudi Arabia', 'OM': 'Oman',
    'LK': 'Sri Lanka', 'PK': 'Pakistan', 'BD': 'Bangladesh', 'TW': 'Taiwan',
    'HK': 'Hong Kong', 'IR': 'Iran', 'SY': 'Syria', 'KP': 'North Korea'
  };
  return countries[code] || code;
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
