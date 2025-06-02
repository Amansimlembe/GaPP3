import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';

const CountrySelector = ({ token, userId, virtualNumber, onComplete }) => {
  const [selectedCountry, setSelectedCountry] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (virtualNumber) {
      onComplete(virtualNumber); // Skip if virtualNumber is already set
      return;
    }

    const handleClickOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        onComplete(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [virtualNumber, onComplete]);

  const checkLocation = async (selectedCountry) => {
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject);
      });
      const { latitude, longitude } = position.coords;
      const response = await axios.get(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
      const currentCountryCode = response.data.countryCode;
      if (currentCountryCode !== selectedCountry) {
        setError('Selected country does not match your current location.');
        return false;
      }
      return true;
    } catch (err) {
      setError('Unable to detect location. Please ensure you are in the selected country.');
      return false;
    }
  };

  const saveCountry = async () => {
    if (!selectedCountry) {
      setError('Please select a country');
      return;
    }

    const locationValid = await checkLocation(selectedCountry);
    if (!locationValid) return;

    try {
      const { data } = await axios.post(
        '/auth/update_country',
        { userId, country: selectedCountry },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      onComplete(data.virtualNumber);
    } catch (error) {
      console.error('Save country error:', error);
      setError(error.response?.data?.error || 'Failed to save country');
    }
  };

  const countries = getCountries().map(code => ({
    code,
    name: new Intl.DisplayNames(['en'], { type: 'region' }).of(code),
  }));
  const filteredCountries = countries.filter(c => 
    c.name.toLowerCase().includes(search.toLowerCase()) || 
    c.code.toLowerCase().includes(search.toLowerCase())
  );

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter' && filteredCountries.length > 0) {
      setSelectedCountry(filteredCountries[0].code);
      setSearch(''); // Clear search after selecting
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div ref={wrapperRef} className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-xl font-bold text-primary dark:text-gray-300 mb-4">Select Your Country</h2>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          className="w-full p-2 mb-4 border rounded-lg dark:bg-gray-700 dark:text-white"
          placeholder="Search for a country..."
        />
        <select
          value={selectedCountry}
          onChange={(e) => setSelectedCountry(e.target.value)}
          className="w-full p-2 mb-4 border rounded-lg dark:bg-gray-700 dark:text-white"
          size="5"
        >
          {filteredCountries.map(c => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
        <button onClick={saveCountry} className="w-full bg-primary text-white p-2 rounded-lg hover:bg-secondary dark:bg-gray-700">Save</button>
      </div>
    </motion.div>
  );
};

export default CountrySelector;