import { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';

const prisma = new PrismaClient();

// ── Inlined entropy-weighted artist popularity ──────────────────────────────
// Previously imported from '../src/utils/artistPopularity', which was removed
// as part of the Legacy Popularity System C cleanup (that module's only other
// consumer, concertPipeline.service.ts, was removed in the same pass). This is
// a minimal local copy of the same formula/behavior, kept only so this
// standalone script continues to run unchanged; it is not used by any other
// current-architecture code. The cohort model is now built once per run
// (from the same `artists` list this script already fetches) instead of being
// recomputed/Redis-cached per call, which is behaviorally equivalent for a
// single batch run.

type ArtistPopularityInput = {
  spotifyMonthlyListeners?: unknown;
  youtubeSubscribers?: unknown;
  instagramFollowers?: unknown;
  facebookFollowers?: unknown;
  twitterFollowers?: unknown;
};

type ArtistPopularityPlatform = keyof ArtistPopularityInput;
type ArtistPopularityWeights = Record<ArtistPopularityPlatform, number>;

const ARTIST_POPULARITY_PLATFORMS: ArtistPopularityPlatform[] = [
  'spotifyMonthlyListeners',
  'youtubeSubscribers',
  'instagramFollowers',
  'facebookFollowers',
  'twitterFollowers',
];

const DEFAULT_FALLBACK_POPULARITY = 45;

type EntropyArtistPopularityModel = {
  weights: ArtistPopularityWeights;
  maxValues: ArtistPopularityWeights;
  sampleSize: number;
};

function toFiniteNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function transformReachValue(value: number): number {
  return Math.log1p(Math.max(0, value));
}

function hasReachData(artist: ArtistPopularityInput): boolean {
  return ARTIST_POPULARITY_PLATFORMS.some((platform) => toFiniteNumber(artist[platform]) > 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function calculateEntropyWeights(normalizedRows: number[][]): ArtistPopularityWeights {
  const sampleSize = normalizedRows.length;
  const entropyFactor = sampleSize > 1 ? 1 / Math.log(sampleSize) : 0;

  const diversification = ARTIST_POPULARITY_PLATFORMS.map((_, columnIndex) => {
    const column = normalizedRows.map((row) => row[columnIndex]);
    const columnSum = column.reduce((sum, value) => sum + value, 0);
    if (columnSum <= 0 || entropyFactor === 0) return 0;

    const entropy = -entropyFactor * column.reduce((sum, value) => {
      if (value <= 0) return sum;
      const probability = value / columnSum;
      return sum + probability * Math.log(probability);
    }, 0);

    return Math.max(0, 1 - entropy);
  });

  const totalDiversification = diversification.reduce((sum, value) => sum + value, 0);
  if (totalDiversification <= 0) {
    return ARTIST_POPULARITY_PLATFORMS.reduce((weights, platform) => {
      weights[platform] = 1 / ARTIST_POPULARITY_PLATFORMS.length;
      return weights;
    }, {} as ArtistPopularityWeights);
  }

  return ARTIST_POPULARITY_PLATFORMS.reduce((weights, platform, index) => {
    weights[platform] = diversification[index] / totalDiversification;
    return weights;
  }, {} as ArtistPopularityWeights);
}

function buildEntropyArtistPopularityModel(
  artists: ArtistPopularityInput[]
): EntropyArtistPopularityModel {
  const transformedRows = artists.map((artist) =>
    ARTIST_POPULARITY_PLATFORMS.map((platform) =>
      transformReachValue(toFiniteNumber(artist[platform]))
    )
  );

  const maxValues = ARTIST_POPULARITY_PLATFORMS.reduce((values, platform, index) => {
    values[platform] = Math.max(...transformedRows.map((row) => row[index]), 0);
    return values;
  }, {} as ArtistPopularityWeights);

  const normalizedRows = transformedRows.map((row) =>
    row.map((value, index) => {
      const max = maxValues[ARTIST_POPULARITY_PLATFORMS[index]];
      return max > 0 ? value / max : 0;
    })
  );

  const weights = calculateEntropyWeights(normalizedRows);

  return {
    weights,
    maxValues,
    sampleSize: artists.length,
  };
}

function calculateArtistPopularityWithModel(
  artist: ArtistPopularityInput,
  model: EntropyArtistPopularityModel,
  fallback = DEFAULT_FALLBACK_POPULARITY
): number {
  if (!hasReachData(artist)) return fallback;

  const score = ARTIST_POPULARITY_PLATFORMS.reduce((sum, platform) => {
    const max = model.maxValues[platform] || 0;
    const normalized = max > 0
      ? transformReachValue(toFiniteNumber(artist[platform])) / max
      : 0;
    return sum + normalized * model.weights[platform];
  }, 0);

  return round(clamp(5 + score * 95, 5, 100), 2);
}

// Simple coordinates mapping for major cities (latitude, longitude)
const cityCoordinates: Record<string, { lat: number; lng: number }> = {
  // India
  'mumbai': { lat: 19.0760, lng: 72.8777 },
  'delhi': { lat: 28.7041, lng: 77.1025 },
  'new delhi': { lat: 28.7041, lng: 77.1025 },
  'bangalore': { lat: 12.9716, lng: 77.5946 },
  'bengaluru': { lat: 12.9716, lng: 77.5946 },
  'hyderabad': { lat: 17.3850, lng: 78.4867 },
  'chennai': { lat: 13.0827, lng: 80.2707 },
  'pune': { lat: 18.5204, lng: 73.8567 },
  'kolkata': { lat: 22.5726, lng: 88.3639 },
  'ahmedabad': { lat: 23.0225, lng: 72.5714 },
  'jaipur': { lat: 26.9124, lng: 75.7873 },
  'lucknow': { lat: 26.8467, lng: 80.9462 },
  'kanpur': { lat: 26.4499, lng: 80.3319 },
  'nagpur': { lat: 21.1458, lng: 79.0882 },
  'indore': { lat: 22.7196, lng: 75.8577 },
  'thane': { lat: 19.2183, lng: 72.9781 },
  'bhopal': { lat: 23.2599, lng: 77.4126 },
  'visakhapatnam': { lat: 17.6868, lng: 83.2185 },
  'patna': { lat: 25.5941, lng: 85.1376 },
  'vadodara': { lat: 22.3072, lng: 73.1812 },
  'ghaziabad': { lat: 28.6692, lng: 77.4538 },
  'ludhiana': { lat: 30.9010, lng: 75.8573 },
  'agra': { lat: 27.1767, lng: 78.0081 },
  'nashik': { lat: 20.0059, lng: 73.7910 },
  'faridabad': { lat: 28.4089, lng: 77.3178 },
  'meerut': { lat: 28.9845, lng: 77.7064 },
  'rajkot': { lat: 22.3039, lng: 70.8022 },
  'kalyan': { lat: 19.2437, lng: 73.1355 },
  'vasai-virar': { lat: 19.4672, lng: 72.8189 },
  'varanasi': { lat: 25.3176, lng: 82.9739 },
  'srinagar': { lat: 34.0837, lng: 74.7973 },
  'aurangabad': { lat: 19.8762, lng: 75.3433 },
  'dhanbad': { lat: 23.7957, lng: 86.4304 },
  'amritsar': { lat: 31.6340, lng: 74.8723 },
  'allahabad': { lat: 25.4358, lng: 81.8463 },
  'ranchi': { lat: 23.3441, lng: 85.3096 },
  'howrah': { lat: 22.5958, lng: 88.2636 },
  'coimbatore': { lat: 11.0168, lng: 76.9558 },
  'jabalpur': { lat: 23.1815, lng: 79.9884 },
  'gwalior': { lat: 26.2183, lng: 78.1828 },
  'vijayawada': { lat: 16.5062, lng: 80.6480 },
  'jodhpur': { lat: 26.2389, lng: 73.0243 },
  'madurai': { lat: 9.9252, lng: 78.1198 },
  'raipur': { lat: 21.2514, lng: 81.6296 },
  'kota': { lat: 25.2138, lng: 75.8648 },
  'guwahati': { lat: 26.1445, lng: 91.7362 },
  'solapur': { lat: 17.6599, lng: 75.9064 },
  'hubli–dharwad': { lat: 15.3647, lng: 75.1240 },
  'bareilly': { lat: 28.3670, lng: 79.4304 },
  'moradabad': { lat: 28.8389, lng: 78.7730 },
  'mysore': { lat: 12.2958, lng: 76.6394 },
  'tiruppur': { lat: 11.1085, lng: 77.3411 },
  'gurgaon': { lat: 28.4595, lng: 77.0266 },
  'aligarh': { lat: 27.8974, lng: 78.0880 },
  'jalandhar': { lat: 31.3260, lng: 75.5762 },
  'bhiwandi': { lat: 19.2965, lng: 73.0550 },
  'saharanpur': { lat: 29.9641, lng: 77.5461 },
  'gorakhpur': { lat: 26.7543, lng: 83.3728 },
  'bikaner': { lat: 28.0229, lng: 73.3119 },
  'ambattur': { lat: 13.0906, lng: 80.1656 },
  'jalgaon': { lat: 21.0084, lng: 75.5625 },
  'ulhasnagar': { lat: 19.2125, lng: 73.1494 },
  'nellore': { lat: 14.4426, lng: 79.9865 },
  'jamnagar': { lat: 22.4724, lng: 70.0647 },
  'belgaum': { lat: 15.8497, lng: 74.4977 },
  'mangalore': { lat: 12.9141, lng: 74.8560 },
  // International major cities
  'dubai': { lat: 25.2048, lng: 55.2708 },
  'abu dhabi': { lat: 24.4539, lng: 54.3773 },
  'london': { lat: 51.5074, lng: -0.1278 },
  'new york': { lat: 40.7128, lng: -74.0060 },
  'los angeles': { lat: 34.0522, lng: -118.2437 },
  'chicago': { lat: 41.8781, lng: -87.6298 },
  'houston': { lat: 29.7604, lng: -95.3698 },
  'phoenix': { lat: 33.4484, lng: -112.0740 },
  'philadelphia': { lat: 39.9526, lng: -75.1652 },
  'san antonio': { lat: 29.4241, lng: -98.4936 },
  'san diego': { lat: 32.7157, lng: -117.1611 },
  'dallas': { lat: 32.7767, lng: -96.7970 },
  'san jose': { lat: 37.3382, lng: -121.8863 },
  'austin': { lat: 30.2672, lng: -97.7431 },
  'jacksonville': { lat: 30.3322, lng: -81.6557 },
  'fort worth': { lat: 32.7555, lng: -97.3308 },
  'columbus': { lat: 39.9612, lng: -82.9988 },
  'charlotte': { lat: 35.2271, lng: -80.8431 },
  'san francisco': { lat: 37.7749, lng: -122.4194 },
  'indianapolis': { lat: 39.7684, lng: -86.1581 },
  'seattle': { lat: 47.6062, lng: -122.3321 },
  'denver': { lat: 39.7392, lng: -104.9903 },
  'washington': { lat: 38.9072, lng: -77.0369 },
  'boston': { lat: 42.3601, lng: -71.0589 },
  'el paso': { lat: 31.7619, lng: -106.4850 },
  'detroit': { lat: 42.3314, lng: -83.0458 },
  'nashville': { lat: 36.1627, lng: -86.7816 },
  'portland': { lat: 45.5152, lng: -122.6784 },
  'oklahoma city': { lat: 35.4676, lng: -97.5164 },
  'las vegas': { lat: 36.1699, lng: -115.1398 },
  'memphis': { lat: 35.1495, lng: -90.0490 },
  'louisville': { lat: 38.2527, lng: -85.7585 },
  'baltimore': { lat: 39.2904, lng: -76.6122 },
  'milwaukee': { lat: 43.0389, lng: -87.9065 },
  'albuquerque': { lat: 35.0844, lng: -106.6504 },
  'tucson': { lat: 32.2217, lng: -110.9265 },
  'fresno': { lat: 36.7378, lng: -119.7871 },
  'sacramento': { lat: 38.5816, lng: -121.4944 },
  'kansas city': { lat: 39.0997, lng: -94.5786 },
  'long beach': { lat: 33.7701, lng: -118.1937 },
  'colorado springs': { lat: 38.8339, lng: -104.8214 },
  'raleigh': { lat: 35.7796, lng: -78.6382 },
  'miami': { lat: 25.7617, lng: -80.1918 },
  'virginia beach': { lat: 36.8529, lng: -75.9780 },
  'oxnard': { lat: 34.1976, lng: -119.1771 },
  'henderson': { lat: 36.0395, lng: -115.0459 },
  'st. louis': { lat: 38.6270, lng: -90.1994 },
  'tampa': { lat: 27.9506, lng: -82.4572 },
  'irkutsk': { lat: 52.2878, lng: 104.2963 },
  'omsk': { lat: 54.9891, lng: 73.3682 },
  'novosibirsk': { lat: 55.0084, lng: 82.9357 },
  'pergamino': { lat: -33.8900, lng: -60.5700 },
  // Add more cities as needed
};

/**
 * Get coordinates for a city (case-insensitive)
 */
function getCoordinatesForCity(cityName: string): { lat: number; lng: number } | null {
  if (!cityName) return null;

  const normalizedCity = cityName.toLowerCase().trim();
  return cityCoordinates[normalizedCity] || null;
}

async function updateAllPredictionsWithCoords() {
  try {
    console.log('Starting batch prediction update with coordinates...');
    console.log('Fetching artists and their concerts...');

    // Fetch all artists with their concerts
    const artists = await prisma.artist.findMany({
      include: {
        concerts: true
      }
    });

    // Cohort entropy model built once from this same artist list, reused for
    // every concert below (see the inlined-popularity note near the top of
    // this file for why this is computed locally instead of imported).
    const popularityModel = buildEntropyArtistPopularityModel(artists);

    let totalConcerts = 0;
    let processedCount = 0;
    let errorCount = 0;

    for (const artist of artists) {
      for (const concert of artist.concerts) {
        totalConcerts++;

        const input = {
          artist_popularity: calculateArtistPopularityWithModel(artist, popularityModel),
          artist_city_popularity: concert.artistCityPopularity ? Number(concert.artistCityPopularity) : 50,
          venue_capacity: concert.capacity ? Number(concert.capacity) : 5000,
          city: concert.city,
          currency: concert.currency || 'INR'
        };

        // Get coordinates if available
        const coordinates = getCoordinatesForCity(concert.city);
        const latitude = coordinates?.lat ?? concert.latitude ?? null;
        const longitude = coordinates?.lng ?? concert.longitude ?? null;

        // Convert input to JSON string for the Python script
        const inputJson = JSON.stringify(input);

        // Call the ML processor
        const processorPath = path.join(__dirname, '..', 'ml_engine', 'processor.py');
        const pythonProcess = spawn('python', [processorPath, inputJson]);

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        // Wrap in Promise to handle async
        const result = await new Promise<{ success: boolean; output: any; error: string | null }>((resolve) => {
          pythonProcess.on('close', (code) => {
            if (code !== 0) {
              resolve({ success: false, output: null, error: stderr || `Process exited with code ${code}` });
            } else {
              try {
                const output = JSON.parse(stdout.trim());
                resolve({ success: true, output, error: null });
              } catch (e) {
                resolve({ success: false, output: null, error: `Failed to parse JSON output: ${e}` });
              }
            }
          });
        });

        if (!result.success) {
          console.error(`Error processing concert ${concert.id}:`, result.error);
          errorCount++;
          continue;
        }

        if (!result.output) {
          console.error(`No output for concert ${concert.id}`);
          errorCount++;
          continue;
        }

        const mlOutput = result.output;
        const concertUpdate = {
          ticketsSold: mlOutput.tickets_sold,
          avgTicketPrice: mlOutput.avg_ticket_price,
          totalRevenue: mlOutput.total_revenue,
          demandScore: mlOutput.demand_score,
          latitude,
          longitude
        };

        // Calculate sellout probability
        const selloutProbability = concert.capacity && concert.capacity > 0
          ? Math.min(0.99, mlOutput.tickets_sold / concert.capacity)
          : 0;

        // Check if prediction already exists for this concert and model version
        const existingPrediction = await prisma.predictionOutput.findFirst({
          where: {
            concertId: concert.id,
            modelVersion: mlOutput.model_version
          }
        });

        if (existingPrediction) {
          // Update existing prediction
          await prisma.predictionOutput.update({
            where: { id: existingPrediction.id },
            data: {
              input: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city: input.city,
                currency: input.currency
              },
              features: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city_market_boost: 0,
                latitude: latitude,
                longitude: longitude
              },
              expectedRevenue: mlOutput.total_revenue, // Already in INR
              expectedAttendance: mlOutput.tickets_sold,
              selloutProbability: Number(selloutProbability.toFixed(4)),
              demandScore: mlOutput.demand_score
            }
          });
        } else {
          // Create new prediction record
          await prisma.predictionOutput.create({
            data: {
              concertId: concert.id,
              modelVersion: mlOutput.model_version,
              input: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city: input.city,
                currency: input.currency
              },
              features: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city_market_boost: 0,
                latitude: latitude,
                longitude: longitude
              },
              expectedRevenue: mlOutput.total_revenue, // Already in INR
              expectedAttendance: mlOutput.tickets_sold,
              selloutProbability: Number(selloutProbability.toFixed(4)),
              demandScore: mlOutput.demand_score
            }
          });
        }

        await prisma.concert.update({
          where: { id: concert.id },
          data: concertUpdate
        });

        processedCount++;

        // Progress reporting
        if (processedCount % 50 === 0) {
          console.log(`Processed ${processedCount} concerts...`);
        }
      }
    }

    console.log(`\nFinished processing all concerts.`);
    console.log(`Total concerts found: ${totalConcerts}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Errors: ${errorCount}`);

    if (processedCount > 0) {
      console.log(`\n✅ Prediction update with coordinates completed successfully!`);
      console.log(`The PredictionOutput table now contains revenue predictions in INR crores range with coordinates.`);
    }

  } catch (error) {
    console.error('Unexpected error during batch processing:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
updateAllPredictionsWithCoords();
