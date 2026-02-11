const axios = require('axios');

(async () => {
  try {
    console.log('Fetching EUR inflation from Eurostat...');
    
    const res = await axios.get(
      'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr',
      {
        params: {
          format: 'JSON',
          geo: 'EA20',
          coicop: 'CP00',
          unit: 'RCH_A'
        }
      }
    );

    const data = res.data;
    const timeIndex = data.dimension.time.category.index;
    const timeLabels = data.dimension.time.category.label;
    const values = data.value;
    
    // Get the latest 5 time periods (sorted newest first)
    const sortedTimes = Object.keys(timeIndex).sort().reverse().slice(0, 5);
    
    console.log('\nLatest 5 EUR inflation rates (YoY annual change):');
    console.log('================================================');
    sortedTimes.forEach(timePeriod => {
      const dimensionPosition = timeIndex[timePeriod];
      const inflationValue = values[dimensionPosition];
      const label = timeLabels[timePeriod] || timePeriod;
      console.log(`${label} (${timePeriod}): ${inflationValue}% [position ${dimensionPosition}]`);
    });

    // Show the absolute latest
    const latestPeriod = sortedTimes[0];
    const latestPosition = timeIndex[latestPeriod];
    const latestValue = values[latestPosition];
    
    console.log('\n🎯 LATEST VALUE:');
    console.log(`   Period: ${timeLabels[latestPeriod] || latestPeriod}`);
    console.log(`   Inflation: ${latestValue}%`);

  } catch(e) {
    console.error('Error:', e.message);
  }
})();
