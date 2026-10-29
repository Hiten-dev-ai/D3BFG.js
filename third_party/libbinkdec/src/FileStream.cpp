/*
 * libbinkdec - Bink video decoder
 * Copyright (C) 2011 Barry Duncan
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 */

#include "FileStream.h"
#include <stdlib.h>
#include <string.h>
#include "precompiled.h"
#include "framework/File.h"

namespace BinkCommon {

FileStream::FileStream()
	: engineFile(NULL), ownsEngineFile(false), eosFlag(false)
{
}

FileStream::~FileStream()
{
	Close();
}

bool FileStream::Open(const std::string &fileName)
{
	Close();
	file.open(fileName.c_str(), std::ifstream::in | std::ifstream::binary);
	if (!file.is_open())
	{
		// log error
		return false;
	}

	return true;
}

bool FileStream::Open(idFile *fileHandle, bool ownsFile)
{
	Close();
	if (!fileHandle)
	{
		return false;
	}

	engineFile = fileHandle;
	ownsEngineFile = ownsFile;
	eosFlag = false;
	return true;
}

bool FileStream::Is_Open()
{
	if (engineFile != NULL)
	{
		return true;
	}
	return file.is_open();
}

void FileStream::Close()
{
	if (engineFile != NULL)
	{
		if (ownsEngineFile)
		{
			delete engineFile;
		}
		engineFile = NULL;
		ownsEngineFile = false;
		eosFlag = false;
	}

	if (file.is_open())
	{
		file.close();
	}
}

int32_t FileStream::ReadBytes(uint8_t *data, uint32_t nBytes)
{
	if (engineFile != NULL)
	{
		if (nBytes == 0)
		{
			return 0;
		}
		int read = engineFile->Read(reinterpret_cast<void*>(data), static_cast<int>(nBytes));
		if (read < 0)
		{
			eosFlag = true;
			return 0;
		}
		if (static_cast<uint32_t>(read) < nBytes)
		{
			eosFlag = true;
		}
		return static_cast<int32_t>(read);
	}

	file.read(reinterpret_cast<char*>(data), nBytes);

	if (file.eof()) {
		return 0;
	}
	else if (file.fail()) {
		return 0;
	}
	else if (file.bad()) {
		return 0;
	}

	return static_cast<int32_t>(file.gcount());
}

uint32_t FileStream::ReadUint32LE()
{
	uint32_t value = 0;
	if (engineFile != NULL)
	{
		int read = engineFile->Read(&value, 4);
		if (read != 4)
		{
			eosFlag = true;
		}
		return value;
	}

	file.read(reinterpret_cast<char*>(&value), 4);
	return value;
}

uint32_t FileStream::ReadUint32BE()
{
	uint32_t value = 0;
	if (engineFile != NULL)
	{
		int read = engineFile->Read(&value, 4);
		if (read != 4)
		{
			eosFlag = true;
		}
#ifdef _MSC_VER
		return _byteswap_ulong(value);
#else
		return __builtin_bswap32(value);
#endif
	}

	file.read(reinterpret_cast<char*>(&value), 4);
#ifdef _MSC_VER
	return _byteswap_ulong(value);
#else // DG: provide alternative for GCC/clang
	return __builtin_bswap32(value);
#endif
}

uint16_t FileStream::ReadUint16LE()
{
	uint16_t value = 0;
	if (engineFile != NULL)
	{
		int read = engineFile->Read(&value, 2);
		if (read != 2)
		{
			eosFlag = true;
		}
		return value;
	}

	file.read(reinterpret_cast<char*>(&value), 2);
	return value;
}

uint16_t FileStream::ReadUint16BE()
{
	uint16_t value = 0;
	if (engineFile != NULL)
	{
		int read = engineFile->Read(&value, 2);
		if (read != 2)
		{
			eosFlag = true;
		}
#ifdef _MSC_VER
		return _byteswap_ushort(value);
#else
		return __builtin_bswap16(value);
#endif
	}

	file.read(reinterpret_cast<char*>(&value), 2);
#ifdef _MSC_VER
	return _byteswap_ushort(value);
#else // DG: provide alternative for GCC/clang
	return __builtin_bswap16(value);
#endif
}

uint8_t FileStream::ReadByte()
{
	uint8_t value = 0;
	if (engineFile != NULL)
	{
		int read = engineFile->Read(&value, 1);
		if (read != 1)
		{
			eosFlag = true;
		}
		return value;
	}

	file.read(reinterpret_cast<char*>(&value), 1);
	return value;
}

bool FileStream::Seek(int32_t offset, SeekDirection direction)
{
	if (engineFile != NULL)
	{
		fsOrigin_t origin = FS_SEEK_SET;
		if (kSeekStart == direction) {
			origin = FS_SEEK_SET;
		} else if (kSeekCurrent == direction) {
			origin = FS_SEEK_CUR;
		} else if (kSeekEnd == direction) {
			origin = FS_SEEK_END;
		}

		int res = engineFile->Seek(static_cast<long>(offset), origin);
		eosFlag = false;
		return (res >= 0);
	}

	if (kSeekStart == direction) {
		file.seekg(offset, std::ios::beg);
	}
	else if (kSeekCurrent == direction) {
		file.seekg(offset, std::ios::cur);
	}

	// TODO - end seek

	if (file.bad())
	{
		// todo
		return false;
	}
	if (file.fail())
	{
		// todo
		return false;
	}

	return true;
}

bool FileStream::Skip(int32_t offset)
{
	return Seek(offset, kSeekCurrent);
}

bool FileStream::Is_Eos()
{
	if (engineFile != NULL)
	{
		return eosFlag;
	}
	return file.eof();
}

int32_t FileStream::GetPosition()
{
	if (engineFile != NULL)
	{
		return static_cast<int32_t>(engineFile->Tell());
	}
	return static_cast<int32_t>(file.tellg());
}

} // close namespace BinkCommon
