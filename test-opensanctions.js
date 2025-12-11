// TEST ENDPOINT: api/test-opensanctions.js
// Deploy this to Vercel and hit it directly to see what OpenSanctions returns
// URL: https://api.dudediligence.pro/api/test-opensanctions?name=Ruja%20Ignatova

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const name = req.query.name || req.body?.name || 'Ruja Ignatova';
  const apiKey = process.env.OPENSANCTIONS_API_KEY || 'fa8498893ae04b0f97a96a4d3aec49ce';
  
  const debugInfo = {
    searchName: name,
    apiKeyUsed: apiKey.substring(0, 8) + '...',
    apiKeySource: process.env.OPENSANCTIONS_API_KEY ? 'ENV_VAR' : 'HARDCODED',
    timestamp: new Date().toISOString()
  };

  try {
    const url = 'https://api.opensanctions.org/search/default?q=' + encodeURIComponent(name) + '&limit=10';
    debugInfo.requestUrl = url;
    
    console.log('Testing OpenSanctions for: ' + name);
    console.log('Using API key: ' + apiKey.substring(0, 8) + '...');
    
    const startTime = Date.now();
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DDP/1.0',
        'Authorization': 'ApiKey ' + apiKey
      }
    });
    
    const responseTime = Date.now() - startTime;
    debugInfo.responseTime = responseTime + 'ms';
    debugInfo.httpStatus = response.status;
    debugInfo.httpStatusText = response.statusText;
    
    // Get response headers for debugging
    debugInfo.responseHeaders = {};
    response.headers.forEach((value, key) => {
      debugInfo.responseHeaders[key] = value;
    });

    if (!response.ok) {
      // Try to get error body
      let errorBody = null;
      try {
        errorBody = await response.text();
      } catch (e) {
        errorBody = 'Could not read error body';
      }
      
      debugInfo.error = 'API returned non-200 status';
      debugInfo.errorBody = errorBody;
      
      return res.status(200).json({
        success: false,
        message: 'OpenSanctions API returned error: ' + response.status,
        debug: debugInfo
      });
    }

    const data = await response.json();
    debugInfo.totalResults = data.total || 0;
    debugInfo.returnedResults = data.results?.length || 0;
    
    // Show first 5 results with full detail
    const detailedResults = (data.results || []).slice(0, 5).map(r => ({
      name: r.caption,
      score: r.score,
      schema: r.schema,
      datasets: r.datasets,
      topics: r.topics,
      id: r.id
    }));

    // Check if any would be flagged by our logic
    const wouldBeMatched = (data.results || []).filter(r => {
      const isHighPriority = r.datasets?.some(d => {
        const dLower = d.toLowerCase();
        return dLower.includes('interpol') ||
               dLower.includes('fbi') ||
               dLower.includes('europol') ||
               dLower.includes('bka') ||
               dLower.includes('most_wanted') ||
               dLower.includes('wanted') ||
               dLower.includes('crime');
      });
      
      const hasCrimeTopic = r.topics?.some(t => 
        t.includes('crime') || t.includes('wanted') || t.includes('sanction')
      );
      
      return isHighPriority || hasCrimeTopic || r.score > 0.5;
    });

    return res.status(200).json({
      success: true,
      message: 'OpenSanctions API working',
      searchedName: name,
      apiStatus: response.status,
      totalResults: data.total || 0,
      returnedResults: data.results?.length || 0,
      wouldBeMatchedCount: wouldBeMatched.length,
      wouldBeFlagged: wouldBeMatched.length > 0,
      firstFiveResults: detailedResults,
      wouldBeMatchedResults: wouldBeMatched.slice(0, 5).map(r => ({
        name: r.caption,
        score: r.score,
        datasets: r.datasets,
        topics: r.topics,
        matchReason: r.datasets?.some(d => d.toLowerCase().includes('fbi')) ? 'FBI' :
                     r.datasets?.some(d => d.toLowerCase().includes('interpol')) ? 'INTERPOL' :
                     r.datasets?.some(d => d.toLowerCase().includes('bka')) ? 'BKA' :
                     r.topics?.some(t => t.includes('crime')) ? 'CRIME_TOPIC' : 'SCORE>0.5'
      })),
      debug: debugInfo
    });

  } catch (error) {
    debugInfo.error = error.message;
    debugInfo.errorStack = error.stack;
    
    return res.status(200).json({
      success: false,
      message: 'Exception during API call: ' + error.message,
      debug: debugInfo
    });
  }
}
