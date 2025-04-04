import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { getCountries } from 'libphonenumber-js';

const CountrySelector = ({ token, userId, virtualNumber, onComplete }) => {
  const [selectedCountry, setSelectedCountry] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [locationConfirmed, setLocationConfirmed] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (virtualNumber) {
      onComplete(virtualNumber); // Skip if virtualNumber is already set
      return;
    }

    const checkLocation = () => {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          const response = await axios.get(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`);
          const currentCountryCode = response.data.countryCode;
          if (currentCountryCode === selectedCountry) {
            setLocationConfirmed(true);
          } else {
            setError('Selected country does not match your current location.');
          }
        },
        () => setError('Unable to detect location. Please select your current country.')
      );
    };
    if (selectedCountry) checkLocation();

    const handleClickOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        onComplete(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [token, userId, selectedCountry, onComplete, virtualNumber]);

  const saveCountry = async () => {
    if (!selectedCountry) {
      setError('Please select a country');
      return;
    }
    if (!locationConfirmed) {
      setError('Please confirm your location matches the selected country.');
      return;
    }
    try {
      const { data } = await axios.post(
        '/auth/update_country',
        { userId, country: selectedCountry }, // Send only country, backend generates virtualNumber
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

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div ref={wrapperRef} className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-lg w-full max-w-md">
        <h2 className="text-xl font-bold text-primary dark:text-gray-300 mb-4">Select Your Country</h2>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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