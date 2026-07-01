import { calculateStaffingStrategy } from '../utils/erlang';

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  const { forecastToUse, inputs, dimStrategy, dimOpHours } = event.data;
  
  try {
    // Perform the heavy Erlang calculations
    const result = calculateStaffingStrategy(forecastToUse, inputs, dimStrategy, dimOpHours);
    
    // Post the result back to the main thread
    self.postMessage({ success: true, result });
  } catch (error: any) {
    self.postMessage({ success: false, error: error.message || 'Error calculating Erlang' });
  }
});
