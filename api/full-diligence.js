// ============================================
// OPENSANCTIONS CHECK - v5.4 FIXED
// ============================================
async function checkOpenSanctions(name) {
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
      return { found: false, matches: [], lists: [], isPEP: false, isWanted: false };
    }

    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
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
        
        // Check for crime topics
        const hasCrimeTopic = r.topics?.some(t => 
          t.includes('crime') || t.includes('wanted') || t.includes('sanction')
        );
        
        // Accept ANY score for FBI/Interpol/Europol matches - these are authoritative
        if (isHighPriorityList) {
          console.log(`OpenSanctions: HIGH-PRIORITY MATCH: ${r.caption} (score: ${r.score}, datasets: ${r.datasets?.join(', ')})`);
          return true;
        }
        
        // Lower threshold for crime topics
        if (hasCrimeTopic) {
          console.log(`OpenSanctions: Crime topic match: ${r.caption} (score: ${r.score})`);
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
        
        // Check if this is a wanted criminal
        const isWanted = significantMatches.some(m =>
          m.datasets?.some(d => {
            const dLower = d.toLowerCase();
            return dLower.includes('interpol') ||
                   dLower.includes('fbi') ||
                   dLower.includes('europol') ||
                   dLower.includes('wanted') ||
                   dLower.includes('most_wanted') ||
                   dLower.includes('crime');
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

    return { found: false, matches: [], lists: [], isPEP: false, isWanted: false };
  } catch (error) {
    console.error('OpenSanctions error:', error);
    return { found: false, matches: [], lists: [], isPEP: false, isWanted: false };
  }
}


// ============================================
// UK COMPANIES HOUSE - v5.4 FIXED
// ============================================
async function checkUKCompaniesHouse(companyName) {
  try {
    // v5.4 FIX: Use correct env var name and add hardcoded fallback
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
      console.log(`UK Companies House: Found ${company.title} (${company.company_number})`);
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
    return { found: false };
  }
}


// ============================================
// INTERPOL RED NOTICES - v5.4 FIXED
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
      console.log(`Interpol: Strategy 1 found ${data.total || 0} results`);
      
      if (data._embedded?.notices && data._embedded.notices.length > 0) {
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
    console.log(`Interpol: Trying fallback search with just surname: ${surname}`);
    const fallbackResponse = await fetch(
      `https://ws-public.interpol.int/notices/v1/red?name=${encodeURIComponent(surname)}&resultPerPage=50`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (fallbackResponse.ok) {
      const fallbackData = await fallbackResponse.json();
      console.log(`Interpol: Fallback found ${fallbackData.total || 0} results`);
      
      if (fallbackData._embedded?.notices) {
        // Filter to find notices where the forename also appears
        const matchingNotices = fallbackData._embedded.notices.filter(n => {
          const noticeForename = (n.forename || '').toLowerCase();
          const noticeSurname = (n.name || '').toLowerCase();
          const searchForename = forename.toLowerCase();
          const searchSurname = surname.toLowerCase();
          
          // Check if both parts of the name match
          return (noticeForename.includes(searchForename) || searchForename.includes(noticeForename)) &&
                 (noticeSurname.includes(searchSurname) || searchSurname.includes(noticeSurname));
        });
        
        if (matchingNotices.length > 0) {
          console.log(`Interpol: Found ${matchingNotices.length} matching notices via fallback`);
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

    // v5.4 FIX: Strategy 3 - Try reversed name order (some records have SURNAME, Forename)
    console.log(`Interpol: Trying reversed name order`);
    const reversedResponse = await fetch(
      `https://ws-public.interpol.int/notices/v1/red?forename=${encodeURIComponent(surname)}&name=${encodeURIComponent(forename)}&resultPerPage=20`,
      {
        headers: { 'Accept': 'application/json' }
      }
    );

    if (reversedResponse.ok) {
      const reversedData = await reversedResponse.json();
      if (reversedData._embedded?.notices && reversedData._embedded.notices.length > 0) {
        console.log(`Interpol: Found ${reversedData._embedded.notices.length} notices with reversed name`);
        return {
          found: true,
          matches: reversedData._embedded.notices.map(n => ({
            name: n.name + (n.forename ? ', ' + n.forename : ''),
            entityId: n.entity_id,
            nationality: n.nationalities?.join(', '),
            dateOfBirth: n.date_of_birth,
            charges: n.arrest_warrants?.map(w => w.charge).join('; ')
          })),
          totalResults: reversedData.total
        };
      }
    }

    return { found: false, matches: [], totalResults: 0 };
  } catch (error) {
    console.error('Interpol Red Notices error:', error);
    return { found: false, matches: [], totalResults: 0 };
  }
}


// ============================================
// ALSO UPDATE: Main handler sanctions check to handle isWanted
// Find this section and add the isWanted check:
// ============================================

/*
In the main handler, after:
  if (sanctionsResult.found) {
    ...
    // Add sanctions red flag
    results.riskScore += 50;

ADD THIS:
    // v5.4 FIX: Extra penalty for FBI/Interpol wanted criminals
    if (sanctionsResult.isWanted) {
      results.riskScore += 50; // Additional 50 points for wanted criminals
      results.redFlags.push(`🚨 ${entity.name}: WANTED - Found on FBI/Interpol/Europol criminal database`);
    } else {
      results.redFlags.push(`🚨 ${entity.name}: Potential sanctions match found`);
    }
*/
